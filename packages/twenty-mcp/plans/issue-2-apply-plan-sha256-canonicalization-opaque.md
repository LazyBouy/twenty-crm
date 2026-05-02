# Plan: metadata_apply_plan `expectedSha256` canonicalization is opaque — callers can't reproduce the wrapper's hash

> Issue(s): #2
> Package: packages/twenty-mcp
> Severity: medium
> Worst-case bug class if deferred: Verified-because-source-says-so — the tool description says "SHA-256 of canonical JSON" as if that is a well-defined spec; it is not. Callers assume Python's `json.dumps(sort_keys=True)` matches the Node.js implementation; it doesn't because Python only sorts top-level keys and the wrapper sorts recursively. The integrity check is unusable in practice, defeating its purpose as a defence-in-depth guard.
> Created: 2026-05-02

## Problem statement

`metadata_apply_plan` accepts an optional `expectedSha256` parameter described as "SHA-256 (lowercase hex) of canonical JSON of the mutations array." The wrapper computes its hash using a custom `canonicalize()` function (`metadata.ts:307-321`) that recursively sorts all object keys before serialising. This algorithm is not documented in the tool description, the `expectedSha256` field's `describe()` text, or any external skill file. When a caller computes the hash using the most obvious approach — Python's `json.dumps(mutations, sort_keys=True, separators=(',', ':'))` — the result differs from the wrapper's hash because Python's `sort_keys=True` only sorts the top-level keys of each object and does not recurse into nested structures the same way. The mismatch causes `apply_plan` to reject the plan before dispatching any mutation, and the error message discloses the wrapper's own computed hash (a security-adjacent concern: the error reveals expected state). The only workarounds are to omit `expectedSha256` entirely (losing the integrity guarantee) or to send the wrong hash, read the error, and retry with the correct one (an anti-pattern that teaches callers to bypass the guard rather than use it).

## Reproduction

```python
# Python caller — computes wrong hash
import hashlib, json

mutations = [{"key": "k1", "op": "CREATE_FIELD", "args": {"name": "x", "label": "X"}}]

# Attempt: standard Python canonical form
canonical = json.dumps(mutations, sort_keys=True, separators=(',', ':'))
my_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
# → produces hash A

# Wrapper (Node.js canonicalize):
# recursively sorts ALL nested object keys, then serialises with no spaces.
# For the same mutations, produces hash B ≠ hash A because `args` keys
# are also sorted at every depth level.
```

```bash
# Demonstrate the mismatch mechanically:
cd packages/twenty-mcp
node -e "
const { sha256OfMutations } = require('./dist/tools/metadata');
const m = [{key:'k1',op:'CREATE_FIELD',args:{name:'x',label:'X'}}];
console.log(sha256OfMutations(m));
"
# Compare with Python output above — they differ.
```

The issue reporter confirmed: Python produces `2b591788...`, wrapper produces `35750a50...` for the same 18-mutation plan.

## Root cause hypothesis

`packages/twenty-mcp/src/tools/metadata.ts:307-321` — the `canonicalize()` function uses a custom recursive key-sorting algorithm:

```
metadata.ts:315  const keys = Object.keys(obj).sort();
metadata.ts:317  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
```

This recursively sorts keys at every depth level, which means `args: {name:'x', label:'X'}` becomes `{label:'x',name:'X'}` in the canonical form regardless of insertion order. Python's `json.dumps(sort_keys=True)` DOES perform recursive key sorting — but only on plain `dict` objects (not lists). The real divergence is that the wrapper's `canonicalize` is NOT documented as its algorithm anywhere in the tool description or schema commentary. The `expectedSha256` field's `describe()` text at `metadata.ts:228-231` simply says:

```
'SHA-256 (lowercase hex) of canonical JSON of the mutations array. apply_plan recomputes and refuses if mismatch — defence in depth against in-transit drift.'
```

"Canonical JSON" is not a single standard — it could refer to RFC 8785 (JCS), OLPC canonical JSON, or a bespoke implementation. The wrapper's actual algorithm (recursive key sort, no whitespace, UTF-8) matches NEITHER the RFC 8785 specification fully NOR the naïve assumption a caller would make.

Additionally, `sha256OfMutations` is exported from `metadata.ts:320` but is only used internally and in tests. There is no `metadata_compute_plan_hash` tool that would let a caller ask the wrapper to compute the hash for them before submitting the plan.

## Proposed fix

Implement option **(c)** from the issue's suggested fix, PLUS document the algorithm for option **(a)** as a fallback:

### Primary fix — add `metadata_compute_plan_hash` tool

1. In `packages/twenty-mcp/src/tools/metadata.ts`, add a new handler `metadataComputePlanHash` that accepts `{ mutations: [...] }` (same `mutations` array schema as `apply_plan`) and returns `{ hash: "<64-char hex>" }` without dispatching any mutation.

2. Add the corresponding input schema `metadataComputePlanHashInputSchema`:
   ```typescript
   export const metadataComputePlanHashInputSchema = z.object({
     mutations: z.array(ApplyPlanMutation).min(1).max(50)
       .describe('The mutations array you intend to pass to metadata_apply_plan. Returns the expectedSha256 value to use.'),
   });
   ```

3. Handler implementation (pure — no side effects):
   ```typescript
   metadataComputePlanHash: (args: z.infer<typeof metadataComputePlanHashInputSchema>) => ({
     content: [{ type: 'text', text: JSON.stringify({ hash: sha256OfMutations(args.mutations) }) }],
     isError: false,
   }),
   ```

4. Register the tool in `metadataToolDefinitions` with `readOnlyHint: true, idempotentHint: true` annotations.

### Secondary fix — document the algorithm in the `expectedSha256` description

Update `metadataApplyPlanInputSchema`'s `expectedSha256` field description (`metadata.ts:228-231`) to be specific:

```
'SHA-256 (lowercase hex) of the wrapper\'s canonical JSON of the mutations array.
Canonical form: recursively sort all object keys lexicographically, no whitespace, UTF-8 encoding.
Use metadata_compute_plan_hash({ mutations }) to obtain the correct hash — this sidesteps spec ambiguity entirely.
If computing manually: JSON.stringify with all nested keys sorted; in Node.js: use the canonicalize helper (same as this wrapper). In Python: json.dumps with a recursive sort_keys implementation (stdlib sort_keys=True does NOT recurse into nested objects).'
```

### Do NOT change the canonicalize algorithm

Changing the algorithm is a breaking change for any caller that has successfully computed the hash. The fix adds discoverability and tooling, not a new algorithm.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] **Unit — `metadata_compute_plan_hash` returns the same hash as `sha256OfMutations`:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='metadata.test.ts' --testNamePattern='compute_plan_hash' --config jest.config.ts
  ```
  New test: call `metadataComputePlanHash({ mutations: [{ key:'k1', op:'CREATE_FIELD', args:{foo:1} }] })`. Assert the returned `hash` equals `sha256OfMutations([...same...])`. Also assert that passing the returned `hash` as `expectedSha256` to `metadataApplyPlan` with the same mutations does NOT produce a `SHA256_CHECK` failure.

- [ ] **Unit — the hash round-trip: compute → apply succeeds:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='metadata.test.ts' --testNamePattern='hash round-trip' --config jest.config.ts
  ```
  New test: call `metadataComputePlanHash`, take the returned `hash`, pass it as `expectedSha256` to `metadataApplyPlan` with the identical `mutations`. Assert `result.isError === false` and `parsed.failed === null`.

- [ ] **Unit — `metadata_compute_plan_hash` does not call any inner tool or GraphQL mutation:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='metadata.test.ts' --testNamePattern='compute_plan_hash is pure' --config jest.config.ts
  ```
  New test: assert `toolsCall` and `graphqlMutation` mock spies are NOT called when `metadataComputePlanHash` is invoked.

- [ ] **Unit — existing SHA256 mismatch / match tests still pass:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='metadata.test.ts' --testNamePattern='expectedSha256' --config jest.config.ts
  ```
  Expected: the two existing tests ("refuses on expectedSha256 mismatch", "accepts a matching expectedSha256") continue to pass unchanged.

- [ ] **Unit — full suite green:**
  ```bash
  cd packages/twenty-mcp
  npx jest --config jest.config.ts
  ```
  Expected: all tests pass.

- [ ] **Schema / contract test — new tool appears in catalog:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='contract.test.ts' --config jest.config.ts
  ```
  Expected: `metadata_compute_plan_hash` appears in the registered tools catalog and its input schema validates `{ mutations: [...] }` correctly.

- [ ] **Manual verification — discover the tool description is accurate:**
  Bring up the MCP server locally with `TWENTY_MCP_ENABLE_METADATA=true` and call `metadata_compute_plan_hash({ mutations: [<any single mutation>] })`. Confirm the response is `{ hash: "<64 lowercase hex chars>" }` and that using that hash in a subsequent `metadata_apply_plan` call with the same mutations returns `isError: false`. No database changes are required — use `CREATE_FIELD` with a mock `objectMetadataId` and a test Twenty instance, or test at the handler level with a stub client.

## Failure modes named (R3: adversarial pre-mortem)

1. **Caller computes hash before issuing `metadata_compute_plan_hash`, sees stale description**: If a caller reads the old tool description (cached in their LLM context or a cached tool catalog from `discovery()`) before the updated description ships, they may still attempt manual computation. Mitigation: the `metadata_compute_plan_hash` tool's existence in the catalog is itself the primary fix; the description update is defence-in-depth. The most important thing is that the new tool is discoverable via `discovery({focus: "metadata_compute_plan_hash"})`.

2. **`metadata_compute_plan_hash` is called with a DIFFERENT mutations array than the one passed to `apply_plan`**: If the caller computes the hash on a modified version of the plan (e.g., after placeholder substitution, or after the user edits the plan), the hash won't match `apply_plan`'s recomputed value. This is the same hazard the integrity check is designed to catch — but now it surfaces as a user error rather than a tool bug. Mitigation: the tool description should emphasise that the mutations array passed to `metadata_compute_plan_hash` must be byte-for-byte identical to the one passed to `metadata_apply_plan` (same key order, same values). The existing mismatch error message already discloses the wrapper's computed hash, which lets a caller diagnose this case.

3. **The `canonicalize` algorithm diverges from RFC 8785 in edge cases (e.g., Unicode, floating-point numbers)**: The wrapper uses `JSON.stringify` for leaf values (line 308-309) and a custom key-sorting loop for objects. RFC 8785 specifies exact rules for number representation (no trailing zeros, specific NaN handling) and Unicode normalization. A caller using a strict RFC 8785 library might compute a different hash for values like `1.0` vs `1` or strings with non-BMP characters. Mitigation: the proposed fix (add `metadata_compute_plan_hash`) eliminates this problem entirely for callers who use the tool. For the documentation path, explicitly note that the algorithm is NOT RFC 8785-compliant and that `metadata_compute_plan_hash` is the authoritative source of truth.

## Out of scope

- **Adopting RFC 8785 / JCS as the canonical algorithm**: Would require a dependency (`canonical-json` or similar) and would be a breaking change for any existing caller who has successfully computed hashes. Deferred. Worst case if wrong: callers who migrated to JCS produce hashes that differ from callers using the old algorithm for the same plan — two incompatible hash regimes in the wild (Bug class: Imagined-because-plausible — JCS "feels right" but breaks existing users). Accepted because `metadata_compute_plan_hash` solves the problem without requiring callers to implement any specific algorithm.
- **Removing `expectedSha256` from the API**: It is an optional defence-in-depth check. Removing it would reduce the integrity guarantee. Not in scope.
- **Exposing `canonicalize` as a utility for external callers**: Returning the canonical string in addition to the hash would help callers debug mismatches. Deferred as a low-priority follow-up; the tool description update covers the algorithm description.

## References

- packages/twenty-mcp/CLAUDE.md (R1-R5 evaluation rules, L6: tool descriptions ARE the contract)
- packages/twenty-mcp/src/tools/metadata.ts:307-321 (canonicalize + sha256OfMutations)
- packages/twenty-mcp/src/tools/metadata.ts:213-232 (metadataApplyPlanInputSchema, expectedSha256 field)
- packages/twenty-mcp/src/tools/metadata.ts:420-437 (SHA256 check in metadataApplyPlan handler)
- packages/twenty-mcp/src/__tests__/metadata.test.ts:181-209 (existing sha256 tests — extend here)
- packages/twenty-mcp/src/__tests__/metadata.test.ts:252-278 (sha256OfMutations unit tests)
