# Plan: metadata_apply_plan doesn't resolve `$<key>` placeholders between mutations

> Audit round 1: BLOCKED — see [issue-1-apply-plan-placeholder-resolution-audit-round-1.md](./issue-1-apply-plan-placeholder-resolution-audit-round-1.md) (0 critical, 1 high). HIGH defect: id-extraction misses every GraphQL-transport mutation; chained access plans silently break. State reverted to `planned`. Plan needs revision before re-implementation (round 2).
>
> Audit round 2: clean — see [issue-1-apply-plan-placeholder-resolution-audit-round-2.md](./issue-1-apply-plan-placeholder-resolution-audit-round-2.md). HIGH 1 fix verified end-to-end (three-shape extractor at metadata.ts:553-571; new GraphQL-transport test mocks bare `client.graphqlMutation` data). Retrospective at [issue-1-apply-plan-placeholder-resolution-retrospective.md](./issue-1-apply-plan-placeholder-resolution-retrospective.md) (consolidating both rounds). State → `awaiting-commit`.

> Issue(s): #1
> Package: packages/twenty-mcp
> Severity: high
> Worst-case bug class if deferred: Done-because-foreground-checklist-empty — the plan-and-approve protocol advertises chained plans as a first-class pattern, but every chained plan silently half-applies (parent creates, all children fail with "Could not find view for given viewId"), leaving the workspace in partial state.
> Created: 2026-05-02

## Why round 1 was blocked

The round-1 plan correctly identified that GraphQL responses wrap data in `{ success: true, result: data }` via `wrapGraphqlResult` (metadata.ts:267-270) and that inner-tool responses return the id at a different depth than GraphQL responses. However, the plan encoded the WRONG second shape: it hypothesised that the GraphQL transport's `result` field directly contains `{ id, ... }`, when in fact `result` is `{ <mutationName>: { id, ... } }` — the GraphQL mutation name is an extra layer between `parsed.result` and the `id` field.

This meant the round-1 implementation's id-extractor at metadata.ts:541-556 walks `parsed.id ?? parsed.result.id`, which correctly handles inner-tool responses (`{ id }` shape) but NEVER matches GraphQL-transport responses (`{ success: true, result: { createOneRole: { id } } }`) — `parsed.result.id` is undefined; the id lives at `parsed.result.createOneRole.id`. Every `CREATE_ROLE`, `CREATE_API_KEY`, and similar GraphQL-transport CREATE op silently fails to populate the resolved map, causing any downstream `$<key>` reference to report "unresolved placeholder" even though the upstream mutation succeeded.

The round-1 tests only exercised `op: 'CREATE_VIEW'` (inner_tool transport), so the GraphQL-transport path was never covered and the defect shipped green. See [issue-1-apply-plan-placeholder-resolution-audit-round-1.md](./issue-1-apply-plan-placeholder-resolution-audit-round-1.md) HIGH 1 for the full trace.

Round 2 fixes this by extending the id-extractor to walk one level deeper into `parsed.result` to find the first nested object with an `id`, and adds a unit test that exercises a GraphQL-transport CREATE in a chained plan.

## Problem statement

`metadata_apply_plan` is designed to execute an ordered list of mutations as a unit. The `metadata_apply_plan` tool description and the plan-and-approve protocol imply that a caller can express `CREATE_VIEW` followed by `CREATE_VIEW_FIELD` ops that reference the new view's id via `$<key>` placeholders. In practice, no substitution occurs: `metadata.ts:444-478` iterates `args.mutations` and dispatches each mutation's `args` verbatim to the inner tool without maintaining a `results` map or walking the `args` object for placeholder strings. When `create_view_field` receives `viewId: "$create_view__my_view"` it queries Twenty's database for a record with that literal string as UUID, finds nothing, and fails. The parent `CREATE_VIEW` succeeds and persists; all child mutations fail silently (returned as `isError: false` inner-tool responses with failure text). The caller is left with a dangling view and no fields, filters, or sorts attached.

Furthermore, the round-1 implementation's id-extractor only handles inner-tool responses (`{ id }` shape) and not GraphQL-transport responses (`{ success: true, result: { <mutationName>: { id } } }` shape). Every GraphQL-transport CREATE op — `CREATE_ROLE`, `CREATE_API_KEY`, `REVOKE_API_KEY`, `UPSERT_OBJECT_PERMISSION`, `UPSERT_FIELD_PERMISSION`, `INVITE_MEMBERS` — silently fails to populate the resolved map, re-introducing the exact partial-apply hazard on the access plan transport.

## Reproduction

```bash
# Against a local docker-compose Twenty stack with TWENTY_MCP_ENABLE_METADATA=true:
# Send this plan via the MCP proxy — observe that only the first mutation succeeds.

npx dotenv -e .env.local -- npx tsx -e "
const { createServer } = require('./src/server');
// OR: call the handler directly in a test — see Test plan below.
"

# Minimal reproduction via Jest (no live stack required):
cd packages/twenty-mcp
npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='placeholder' --config jest.config.ts
# Expected: test fails because placeholder substitution is not implemented.
# (No such test exists yet — adding it is part of the fix.)
```

Concrete plan from the issue (2026-05-01, `lead-generation-tech-philosophy`):

```json
[
  { "key": "create_view__my_view", "op": "CREATE_VIEW",
    "args": { "name": "My View", "objectNameSingular": "company", "type": "TABLE", "visibility": "WORKSPACE" } },
  { "key": "create_view_field__name", "op": "CREATE_VIEW_FIELD",
    "args": { "viewId": "$create_view__my_view", "fieldMetadataId": "96314745-...", "isVisible": true, "position": 0 } }
]
```

Result: `CREATE_VIEW` produces `id: "9e9c8f7e-..."`. `CREATE_VIEW_FIELD` receives `viewId: "$create_view__my_view"` literally; Twenty's inner tool returns `{ success: false, message: "Could not find view for given viewId" }`.

Equivalent reproduction for the GraphQL transport (the gap round 1 missed):

```json
[
  { "key": "k1", "op": "CREATE_ROLE", "args": { "label": "Sales Lead", "name": "sales_lead", "description": "" } },
  { "key": "k2", "op": "UPSERT_OBJECT_PERMISSION", "args": { "roleId": "$k1", "objectPermissions": [] } }
]
```

Result: `CREATE_ROLE` produces `{ createOneRole: { id: "role-uuid", ... } }` at the GraphQL layer. The round-1 id-extractor resolves to undefined (walks `parsed.result.id`, not `parsed.result.createOneRole.id`). `UPSERT_OBJECT_PERMISSION` fails with "unresolved placeholder $k1".

## Root cause hypothesis

`packages/twenty-mcp/src/tools/metadata.ts:444-478` — the `for (const m of args.mutations)` loop dispatches each mutation's `args` to its transport handler with no intermediate processing. Specifically:

- Line 463-464: `const innerArgs = dispatch.argsTransform ? dispatch.argsTransform(m.args ...) : (m.args ...)` — the `argsTransform` mechanism exists only for structural reshaping (e.g., wrapping a single relation into an array); it is not invoked for placeholder resolution.
- Line 470: `applied.push({ key: m.key, op: m.op, result })` stores the full `ToolsCallResult` but never extracts `result.id` or any other field into a lookup map.
- There is no variable or data structure in the `metadataApplyPlan` handler that accumulates `key → resolved-id` pairs.

The `ApplyPlanResult` type (`metadata.ts:343-348`) captures `result: ToolsCallResult` per applied mutation — the raw result is available in memory after each dispatch, but the code never reads back from it.

**GraphQL-transport id-extraction gap (the round-2 addition):**

The id-extractor at `metadata.ts:541-556` (round-1 implementation) walks:

```ts
const id =
  (parsed.id as string | undefined) ??
  ((parsed.result as Record<string, unknown> | undefined)?.id as string | undefined);
```

There are THREE distinct response shapes across dispatch entries:

1. **Inner-tool transport** (`CREATE_VIEW`, `CREATE_VIEW_FIELD`, etc.): the inner tool returns `{ id: "<uuid>", ... }` directly — `parsed.id` matches.
2. **Defensive wrapper** (intermediate shape if wrapGraphqlResult is ever used with a flat payload): `{ success: true, result: { id: "<uuid>" } }` — `parsed.result.id` matches.
3. **GraphQL transport** (`CREATE_ROLE`, `CREATE_API_KEY`, `UPSERT_OBJECT_PERMISSION`, etc.): `client.graphqlMutation` returns `json.data` (`twenty-mcp-client.ts:202`), which for `mutation { createOneRole(...) { id ... } }` is `{ createOneRole: { id: "<uuid>", ... } }`. `wrapGraphqlResult` (metadata.ts:267-270) wraps that as `{ success: true, result: { createOneRole: { id: "<uuid>", ... } } }`. The id lives at `parsed.result.createOneRole.id`, NOT at `parsed.result.id`. The round-1 extractor never reaches it.

Shape 3 covers all of `accessDispatchEntries`: `CREATE_ROLE`, `UPDATE_ROLE`, `UPSERT_OBJECT_PERMISSION`, `UPSERT_FIELD_PERMISSION`, `INVITE_MEMBERS`, `CREATE_API_KEY`, `REVOKE_API_KEY`. Every one of these silently fails to populate `resolved[m.key]` in the round-1 implementation.

Key file references:
- `packages/twenty-mcp/src/twenty-mcp-client.ts:202` — `graphqlMutation` returns `json.data` (the mutation's top-level response object, which has `{ <mutationName>: { id, ... } }` structure)
- `packages/twenty-mcp/src/tools/metadata.ts:267-270` — `wrapGraphqlResult` layers `{ success: true, result: data }` over `json.data`, making `parsed.result === { <mutationName>: { id, ... } }`
- `packages/twenty-mcp/src/tools/metadata.ts:541-556` — id-extractor walks only two levels; misses the third shape

## Proposed fix

In `packages/twenty-mcp/src/tools/metadata.ts`, inside the `metadataApplyPlan` handler (`metadata.ts:420-488`):

**Step 1.** Before the loop (around line 443), initialise a resolution map:

```typescript
const resolved: Record<string, string> = {};
```

**Step 2.** Define a helper `resolvePlaceholders` that deep-walks an `args` object before dispatch and substitutes `$<key>` (and `${<key>}`) string values:

```typescript
const resolvePlaceholders = (
  value: unknown,
  map: Record<string, string>,
): unknown => {
  if (typeof value === 'string') {
    const simple = value.match(/^\$([a-zA-Z0-9_]+)$/);
    if (simple?.[1] && map[simple[1]] !== undefined) return map[simple[1]];
    const braced = value.match(/^\$\{([a-zA-Z0-9_]+)\}$/);
    if (braced?.[1] && map[braced[1]] !== undefined) return map[braced[1]];
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, map));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolvePlaceholders(v, map)]),
    );
  }
  return value;
};
```

**Step 2.5 — ID extraction: all three transport shapes.**

After each successful mutation's `result` is obtained (around line 541), replace the round-1 extractor with a version that handles all three shapes:

```typescript
// Extract id from the inner-tool's JSON response body for use as placeholder target.
// Three shapes are in play:
//   Shape 1 — inner-tool transport:   { id: "<uuid>", ... }
//   Shape 2 — defensive/flat GraphQL: { success: true, result: { id: "<uuid>", ... } }
//   Shape 3 — GraphQL transport:      { success: true, result: { <mutationName>: { id: "<uuid>", ... } } }
//             (client.graphqlMutation returns json.data === { <mutationName>: {...} };
//              wrapGraphqlResult wraps it as { success: true, result: data };
//              so parsed.result.id is undefined — id is one level deeper)
// Try all three in order; skip silently if no id is found (not all ops return an id).
try {
  const text = (result.content[0] as { type: string; text: string } | undefined)?.text;
  if (text) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const id =
      // Shape 1
      (parsed.id as string | undefined) ??
      // Shape 2
      ((parsed.result as Record<string, unknown> | undefined)?.id as string | undefined) ??
      // Shape 3 — walk one level deeper into parsed.result for the first object with an id
      (() => {
        const r = parsed.result as Record<string, unknown> | undefined;
        if (!r) return undefined;
        for (const v of Object.values(r)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const candidate = (v as Record<string, unknown>).id;
            if (typeof candidate === 'string') return candidate;
          }
        }
        return undefined;
      })();
    if (id) resolved[m.key] = id;
  }
} catch {
  // Non-JSON result — no id to extract.
  // Note: this catch is intentionally broad; it swallows TypeError from undefined
  // result.content as well as SyntaxError from non-JSON text. Placeholder-id extraction
  // is best-effort and a missing id should not abort the whole apply-plan. Do NOT narrow
  // this to SyntaxError only — shape changes would then crash the proxy.
}
```

**Step 3.** Before building `innerArgs` / calling `dispatch.build`, apply placeholder resolution:

```typescript
const effectiveArgs = resolvePlaceholders(m.args, resolved) as Record<string, unknown>;
// then pass effectiveArgs (not m.args) into dispatch.argsTransform and wrapInExecute / dispatch.build
```

**Step 4.** If any arg still contains an unresolved `$<key>` after substitution (i.e., the referenced key was not found in `resolved`), fail the mutation with a clear error:

```
"unresolved placeholder $<key> — referenced mutation '<key>' either failed, was skipped, or does not precede this mutation in the plan"
```

This prevents forwarding literal placeholder strings to Twenty.

**Step 5.** Update the `metadata_apply_plan` tool description (`metadata.ts:640`) to document the placeholder syntax, dependency-ordering rule, AND the whole-string restriction:

Append to the description: `"Placeholders must be the entire string value (e.g. viewId: \"$k1\"); embedded placeholders inside larger strings (e.g. \"created via $k1\") are not substituted and pass through to Twenty literally."`

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] **Unit — placeholder is substituted before dispatch (inner-tool transport):**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='placeholder resolved' --config jest.config.ts
  ```
  New test: call `metadataApplyPlan` with a two-mutation plan where the second mutation's `args` includes `viewId: "$k1"`. Mock the first `toolsCall` to return `{ content: [{ type: 'text', text: '{"id":"uuid-from-k1"}' }] }`. Assert that the second `toolsCall` is called with `{ toolName: 'create_view_field', arguments: { viewId: 'uuid-from-k1', ... } }`.

- [ ] **Unit — placeholder resolved across GraphQL transport (chained access plan):**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='placeholder resolved across graphql transport' --config jest.config.ts
  ```
  New test: mock `client.graphqlMutation` to return `{ createOneRole: { id: 'role-uuid', label: 'X' } }` for the first mutation. Plan: `[{ key: 'k1', op: 'CREATE_ROLE', args: { label: 'X', name: 'x', description: '' } }, { key: 'k2', op: 'UPSERT_OBJECT_PERMISSION', args: { roleId: '$k1', objectPermissions: [] } }]`. Assert the second `graphqlMutation` call's `variables` include `roleId: 'role-uuid'`, NOT `roleId: '$k1'`. This test MUST use `op: 'CREATE_ROLE'` (transport: `graphql`) because that is precisely the path the round-1 implementation missed (inner_tool transport tests were already green while this path was broken).

- [ ] **Unit — unresolved placeholder causes failure, not forwarding:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='unresolved placeholder' --config jest.config.ts
  ```
  New test: single mutation with `args: { viewId: "$nonexistent_key" }`. Assert `result.isError === true` and `parsed.failed.error` matches `/unresolved placeholder/`.

- [ ] **Unit — placeholder not substituted in `resumeFrom`-skipped mutations (skipped mutations don't add to the map):**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='skipped mutation does not populate resolved map' --config jest.config.ts
  ```
  New test: three-mutation plan where k1 is in `resumeFrom`, k2 returns an id, k3 uses `$k1` (should fail — k1 was skipped, not resolved) and `$k2` (should resolve to k2's id). Assert k3 dispatched with `$k2` replaced and `$k1` still producing an unresolved-placeholder error OR that the plan does not use k1's historical id (the point is that skipping does not equal resolving).

- [ ] **Unit — embedded placeholder in a larger string passes through literally (documented contract):**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='embedded placeholder passes through literally' --config jest.config.ts
  ```
  New test: plan with `args: { description: "created via $k1", viewId: "$k1" }` where k1 resolves to `'uuid-1'`. Assert the dispatched `arguments` contain `{ description: "created via $k1", viewId: "uuid-1" }` — only the whole-string placeholder is substituted; the embedded string is forwarded literally. Assert `result.isError === false` (no error for the non-substituted embedded placeholder; it's an intentional pass-through per the documented contract).

- [ ] **Unit — full suite stays green:**
  ```bash
  cd packages/twenty-mcp
  npx jest --config jest.config.ts
  ```
  Expected: all existing tests pass; new tests added above also pass.

- [ ] **Coverage test — `CREATE_VIEW_FIELD` inner tool name still correct after refactor:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPatterns='coverage.test.ts' --config jest.config.ts
  ```
  Expected: green (ensures the refactor didn't accidentally rename `create_view_field`).

- [ ] **Integration smoke (local docker-compose only):**
  ```bash
  cd packages/twenty-mcp
  TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
    npx dotenv -e .env.local -- npx jest --testPathPatterns='round-trip.test.ts' --config jest.config.ts
  ```
  Add a round-trip case that creates a VIEW then a VIEW_FIELD in a single plan using `$<key>` syntax. Assert the view-field row is created with the correct `viewId` UUID in Twenty's database (not the literal placeholder string). Expected: test passes; Twenty returns a non-null `id` for the view field.

## Failure modes named (R3: adversarial pre-mortem)

1. **Skipped mutations pollute the resolved map if handled carelessly**: If the implementer initialises `resolved[m.key]` for `resumeFrom`-skipped mutations using some historical id (e.g., fetched from a SchemaChangeAudit), a subsequent mutation referencing `$skipped_key` may resolve to a stale or wrong UUID from a prior run. Mitigation: explicitly document and test that `resolved` only contains ids from mutations applied in THIS run; the fix proposal above skips the map-population step for `resumeFrom` mutations.

2. **Id-extraction silently misses a transport if the shape enumeration is incomplete**: The id-extractor must handle three concrete shapes: (a) inner-tool transport `{ id: "..." }`, (b) defensive/flat `{ success: true, result: { id: "..." } }`, (c) GraphQL transport `{ success: true, result: { <mutationName>: { id: "..." } } }`. The round-1 implementation handled only (a) and (b), causing every GraphQL CREATE op to silently fail to populate `resolved`. Mitigation: the Step 2.5 extractor walks one level deeper into `parsed.result` using a `for...of Object.values(r)` loop to find the first nested object with a string `id`; a unit test exercising `CREATE_ROLE → UPSERT_OBJECT_PERMISSION` (GraphQL transport, chained plan) enforces this path mechanically. If a future transport introduces a fourth shape, the extractor will silently skip it — the same mechanical test pattern should be extended to cover it.

3. **Partial-apply state after a failed placeholder substitution**: If k1 succeeds and k2 fails due to unresolved placeholder `$k3` (where k3 comes AFTER k2 in the plan), the workspace is left with k1 applied but k2 and k3 unapplied. This is the existing partial-apply hazard that `resumeFrom` is designed to recover from. Mitigation: the fix does not make `apply_plan` atomic (Twenty doesn't support rollback); the error message for unresolved placeholders should explicitly name the resolution: `resumeFrom: ["k1"]` on the retry after fixing the plan. The tool description should be updated to warn that forward-references (referencing a key that appears later in the plan) are not supported.

## Out of scope

- **Dry-run / pre-validation mode**: The issue suggests a dry-run that validates all placeholder references before any mutation is dispatched. This would prevent partial-apply on placeholder errors. Deferred because it requires the wrapper to introspect the resolved map prospectively (before any mutation runs), which in turn requires that every mutation's result-id shape is known statically — not currently true. Worst case if deferred: a plan with a forward-reference in the middle causes partial application (Bug class: Done-because-foreground-checklist-empty — plan looks valid but breaks at step N). Accepted for now because the unresolved-placeholder error message in the fix points directly at the issue and instructs use of `resumeFrom` to recover.
- **`${key}` vs `$key` — support for both**: The fix proposal supports both forms. If only one form is documented, the other becomes a latent silent-failure. Not deferring — both should be supported per the proposed fix above.
- **Nested placeholder chains** (e.g., `$k3` where k3 itself used `$k2`): The `resolved` map stores final ids, not intermediate placeholders, so nested chains are naturally resolved in order so long as the plan is correctly ordered. No additional work needed.
- **MEDIUM 2 — resolved args in audit trail** (`applied[].result` records the inner-tool response but not the post-substitution `effectiveArgs`): Forensic-quality only; does not affect runtime correctness. Deferred as a follow-up issue. Worst case if deferred: audit reconstruction requires reading back the inner-tool response to determine what UUID was actually sent (extra step, not a correctness failure).
- **MEDIUM 3 — JSON.parse size cap**: `JSON.parse(text)` has no size limit; a misbehaving inner tool returning a huge blob could OOM the proxy. Deferred: trust boundary is within the controlled proxy+Twenty system. Worst case if deferred: a buggy find_<plural> inner tool with no limit causes a proxy OOM (Bug class: out-of-scope availability failure, bounded by the trust boundary). One-line fix (`if (text.length > 1_000_000) skip`) if this surfaces.
- **LOW 1 — catch-comment breadth**: The `try { ... } catch {}` around id-extraction silently swallows all errors including `TypeError`, not just `SyntaxError`. Comment says "Non-JSON result" but understates the catch breadth. Intentionally left broad (best-effort extraction should not abort the apply-plan); the updated comment in Step 2.5 now explicitly documents this. Not a correctness issue.
- **LOW 2 — findUnresolved / error message regex coupling**: `findUnresolved` returns the literal placeholder string and the error message re-parses it with a separate regex to extract the key name. If the placeholder regex is widened for embedded placeholders, the re-parser breaks. Deferred foot-gun; relevant only if MEDIUM 1's "extend regex to embedded" option is chosen. Worst case if deferred and embedded regex is added: confusing error messages ("referenced mutation '...embedded text $k1 here...'"). Accepted because the MEDIUM 1 fix chosen here is option (b) — description update only, no regex widening.

## References

- packages/twenty-mcp/CLAUDE.md (architecture invariants + R1–R5 evaluation rules)
- packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution-audit-round-1.md (round-1 audit; HIGH 1 trace)
- packages/twenty-mcp/src/tools/metadata.ts:420-488 (metadataApplyPlan handler — the apply loop)
- packages/twenty-mcp/src/tools/metadata.ts:267-270 (wrapGraphqlResult — layers {success, result: data} over json.data)
- packages/twenty-mcp/src/tools/metadata.ts:343-348 (ApplyPlanResult type)
- packages/twenty-mcp/src/tools/metadata.ts:541-556 (round-1 id-extractor — the defective code to be replaced)
- packages/twenty-mcp/src/tools/metadata.ts:640 (metadata_apply_plan tool description — add whole-string constraint sentence)
- packages/twenty-mcp/src/twenty-mcp-client.ts:202 (graphqlMutation returns json.data — root of the three-shape divergence)
- packages/twenty-mcp/src/__tests__/metadata.test.ts:102-507 (existing apply_plan test suite — extend here)

## Implementation notes
> Implemented: 2026-05-02T00:00:00Z

### Files changed
packages/twenty-mcp/src/__tests__/metadata.test.ts
packages/twenty-mcp/src/tools/metadata.ts

(`.gitignore` also appears in `git diff --name-only` but it was already dirty before this session started — unrelated to this plan.)

### Diff stat
```
 packages/twenty-mcp/src/__tests__/metadata.test.ts | 114 +++++++++++++++++++++
 packages/twenty-mcp/src/tools/metadata.ts          |  96 ++++++++++++++++-
 2 files changed, 207 insertions(+), 3 deletions(-)
```

### Test results

**1. Unit — placeholder is substituted before dispatch**
```
=== npx jest --testPathPattern='metadata.test.ts' --testNamePattern='placeholder resolved' --config jest.config.ts ===
PASS src/__tests__/metadata.test.ts
  metadata_apply_plan — placeholder resolution
    ✓ placeholder resolved: $<key> in second mutation args is substituted with id from first mutation result (4 ms)
Tests: 44 skipped, 1 passed, 45 total
=== exit: 0 ===
```
PASS

**2. Unit — unresolved placeholder causes failure, not forwarding**
```
=== npx jest --testPathPattern='metadata.test.ts' --testNamePattern='unresolved placeholder' --config jest.config.ts ===
PASS src/__tests__/metadata.test.ts
  metadata_apply_plan — placeholder resolution
    ✓ unresolved placeholder: mutation with $nonexistent_key fails with isError=true and unresolved placeholder message (4 ms)
Tests: 44 skipped, 1 passed, 45 total
=== exit: 0 ===
```
PASS

**3. Unit — skipped mutations don't populate resolved map**
```
=== npx jest --testPathPattern='metadata.test.ts' --testNamePattern='skipped mutation does not populate resolved map' --config jest.config.ts ===
PASS src/__tests__/metadata.test.ts
  metadata_apply_plan — placeholder resolution
    ✓ skipped mutation does not populate resolved map: $skipped_key fails, $applied_key resolves (15 ms)
Tests: 44 skipped, 1 passed, 45 total
=== exit: 0 ===
```
PASS

**4. Unit — full suite stays green**
```
=== npx jest --config jest.config.ts ===
PASS src/__tests__/metadata.test.ts (8.367 s)
PASS src/__tests__/config.test.ts (8.955 s)
PASS src/__tests__/twenty-mcp-client.test.ts (8.993 s)
PASS src/__tests__/coverage.test.ts (9.017 s)
PASS src/__tests__/workflows.test.ts (9.105 s)
PASS src/__tests__/crm.test.ts (9.169 s)
PASS src/__tests__/discovery-catalog-shape.test.ts (9.158 s)
PASS src/__tests__/discovery.test.ts (9.215 s)
PASS src/__tests__/views.test.ts (9.256 s)
PASS src/__tests__/note-targets.test.ts (9.271 s)
PASS src/__tests__/access.test.ts (9.236 s)
PASS src/__tests__/contract.test.ts (9.588 s)
Test Suites: 12 passed, 12 total
Tests:       148 passed, 148 total
Time:        10.753 s
=== exit: 0 ===
```
PASS

**5. Coverage test — CREATE_VIEW_FIELD inner tool name still correct after refactor**
```
=== npx jest --testPathPattern='coverage.test.ts' --config jest.config.ts ===
PASS src/__tests__/coverage.test.ts
  coverage: every wrapper-authored downstream reference exists on the deployed Twenty
    inner tool names exist in inner-tool-schemas fixture
      ✓ metadata.ts: every toolName: '<X>' literal resolves to a fixture entry (1 ms)
      ... (all 16 tests passed)
Test Suites: 1 passed, 1 total
Tests:       16 passed, 16 total
=== exit: 0 ===
```
PASS

**6. Integration smoke (local docker-compose)**
DEFERRED — no local Twenty stack running; `curl http://localhost:4440/healthz` returned no response. Flagged for supervisor verification before commit.

### Surprises

1. The plan's test commands use `--testPathPattern=` (singular) but the installed Jest version (29.x) replaced that flag with `--testPathPatterns` (plural). The commands were adapted to use `--testPathPatterns` while keeping the pattern value identical. The test NAME filter (`--testNamePattern`) still works unchanged.

2. The `findUnresolved` helper had to be co-located inside the handler (alongside `resolvePlaceholders`) rather than as a module-level function, to keep scope minimal and consistent with the plan's description of where resolvePlaceholders lives. This is a minor structural choice with no semantic impact.

3. The `git diff --name-only` output includes `.gitignore` — this was dirty before the session began (noted in the initial git status). It is outside the plan's scope and was not touched.

### Audit annotations (round 1)

> **LOW 1 — catch-comment breadth (metadata.ts:545-556):** The `try { ... } catch {}` around id-extraction silently drops any error including `TypeError` from undefined `result.content`. The comment says "Non-JSON result" but the catch is broader. This is intentional (placeholder-id is best-effort and a missing id should not abort the whole apply-plan), but the comment understates the swallowed error class. A future reader could be tempted to narrow the catch to `SyntaxError` only, which would re-introduce a crash on shape changes. Round-2 plan updates the catch comment to explicitly document this broadness.

> **LOW 2 — findUnresolved / error message regex coupling (metadata.ts:519-525):** The error message re-parses the placeholder string with a second `^\$\{?...\}?$`-anchored regex to extract the bare key name. If the placeholder regex is ever widened to support embedded placeholders (MEDIUM 1 option a), the re-parser breaks silently, producing confusing error messages. Only relevant if the regex is widened; the round-2 fix chooses MEDIUM 1 option (b) (description update, no regex change), so this foot-gun is dormant. Recorded here for the next implementer who might be tempted to widen the regex.

## Implementation notes — round 2
> Implemented: 2026-05-02T00:00:00Z

### Files changed
```
packages/twenty-mcp/src/__tests__/metadata.test.ts
packages/twenty-mcp/src/tools/metadata.ts
```

(`.gitignore`, `packages/twenty-mcp/CLAUDE.md` also appear in `git diff --name-only` but were already dirty before this session — unrelated to this plan.)

### Diff stat
```
 packages/twenty-mcp/src/__tests__/metadata.test.ts | 205 +++++++++++++++++++++
 packages/twenty-mcp/src/tools/metadata.ts          | 119 +++++++++++-
 2 files changed (plan-relevant files only)
```

### Test results

**1. Unit — placeholder resolved across GraphQL transport**
```
=== npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='placeholder resolved across graphql transport' --config jest.config.ts ===
PASS src/__tests__/metadata.test.ts
  metadata_apply_plan — placeholder resolution
    ✓ placeholder resolved across graphql transport: CREATE_ROLE id substituted into UPSERT_OBJECT_PERMISSION roleId (4 ms)
Tests: 46 skipped, 1 passed, 47 total
=== exit: 0 ===
```
PASS

**2. Unit — embedded placeholder passes through literally**
```
=== npx jest --testPathPatterns='metadata.test.ts' --testNamePattern='embedded placeholder passes through literally' --config jest.config.ts ===
PASS src/__tests__/metadata.test.ts
  metadata_apply_plan — placeholder resolution
    ✓ embedded placeholder passes through literally: only whole-string $<key> is substituted (5 ms)
Tests: 46 skipped, 1 passed, 47 total
=== exit: 0 ===
```
PASS

**3. Full suite**
```
=== npx jest --config jest.config.ts ===
PASS src/__tests__/coverage.test.ts (8.22 s)
PASS src/__tests__/twenty-mcp-client.test.ts (8.512 s)
PASS src/__tests__/discovery.test.ts (8.618 s)
PASS src/__tests__/config.test.ts (8.658 s)
PASS src/__tests__/note-targets.test.ts (8.648 s)
PASS src/__tests__/workflows.test.ts (8.744 s)
PASS src/__tests__/discovery-catalog-shape.test.ts (8.786 s)
PASS src/__tests__/crm.test.ts (9.044 s)
PASS src/__tests__/metadata.test.ts (9.158 s)
PASS src/__tests__/views.test.ts (9.619 s)
PASS src/__tests__/access.test.ts (9.642 s)
PASS src/__tests__/contract.test.ts (10.303 s)
Test Suites: 12 passed, 12 total
Tests:       150 passed, 150 total
Time:        11.765 s
=== exit: 0 ===
```
PASS — 150 tests (148 round-1 baseline + 2 new).

**4. Coverage test — CREATE_VIEW_FIELD inner tool name still correct after refactor**
```
=== npx jest --testPathPatterns='coverage.test.ts' --config jest.config.ts ===
PASS src/__tests__/coverage.test.ts
  coverage: every wrapper-authored downstream reference exists on the deployed Twenty
    inner tool names exist in inner-tool-schemas fixture
      ✓ access.ts: every toolName: '<X>' literal resolves to a fixture entry (1 ms)
      ✓ crm.ts: every toolName: '<X>' literal resolves to a fixture entry
      ✓ discovery.ts: every toolName: '<X>' literal resolves to a fixture entry (1 ms)
      ✓ metadata.ts: every toolName: '<X>' literal resolves to a fixture entry
      ✓ note-targets.ts: every toolName: '<X>' literal resolves to a fixture entry (1 ms)
      ✓ views.ts: every toolName: '<X>' literal resolves to a fixture entry
      ✓ workflows.ts: every toolName: '<X>' literal resolves to a fixture entry (1 ms)
    GraphQL operations (queries + mutations) + input types exist on the correct endpoint
      ✓ access.ts: every GraphQL operation name exists on its target endpoint (1 ms)
      ✓ access.ts: every GraphQL input type referenced exists on the same endpoint (1 ms)
      ✓ access.ts: every selected response field exists on the operation's return type (1 ms)
      ✓ metadata.ts: every GraphQL operation name exists on its target endpoint (1 ms)
      ✓ metadata.ts: every GraphQL input type referenced exists on the same endpoint
      ✓ metadata.ts: every selected response field exists on the operation's return type (1 ms)
      ✓ note-targets.ts: every GraphQL operation name exists on its target endpoint
      ✓ note-targets.ts: every GraphQL input type referenced exists on the same endpoint
      ✓ note-targets.ts: every selected response field exists on the operation's return type (1 ms)
Test Suites: 1 passed, 1 total
Tests:       16 passed, 16 total
=== exit: 0 ===
```
PASS

**5. Integration smoke (local docker-compose)**
DEFERRED — no local Twenty stack running. Flagged for supervisor verification before commit.

### Surprises

1. The first draft of the GraphQL-transport test asserted `secondCallVariables.roleId === 'role-uuid'` directly, but `buildUpsertObjectPermissions` in `access.ts` wraps `args` as `{ input: args }` before passing to `client.graphqlMutation`. The variables passed to `graphqlMutation` are therefore `{ input: { roleId, objectPermissions } }`, not `{ roleId, objectPermissions }` at the top level. The assertion was corrected to `secondCallVariables.input.roleId`. This is correct behaviour — the placeholder substitution happens on `effectiveArgs` before `dispatch.build(effectiveArgs)` is called, so `effectiveArgs.roleId === 'role-uuid'` feeds into `buildUpsertObjectPermissions` which then wraps it correctly. The test now verifies the substituted value at the correct depth.

2. The `git diff --stat` includes `.gitignore` and `packages/twenty-mcp/CLAUDE.md` — both were dirty before this session started (confirmed in the initial git status). Neither was touched in this round.
