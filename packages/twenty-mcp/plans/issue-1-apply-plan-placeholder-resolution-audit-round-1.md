# Audit report: metadata_apply_plan placeholder resolution — round 1

> Plan: packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution.md
> Round: 1
> Audited: 2026-05-02T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | `npx tsc --noEmit` — clean. |
| Lint (`npx nx lint:diff-with-main twenty-mcp`) | TOOLING FAIL (pre-existing) | Target does not exist (`Cannot find configuration for task twenty-mcp:lint:diff-with-main`). Falling back to `npx nx lint twenty-mcp` fails because `packages/twenty-mcp/.oxlintrc.json` is missing — not introduced by this diff. The lint `target` body in `project.json` is literally `"lint": {}` so Nx infers a default oxlint command that has no matching config file. Pre-existing baseline issue. |
| Lint — prettier on touched files | FAIL (but pre-existing baseline) | `npx prettier --check src/tools/metadata.ts src/__tests__/metadata.test.ts` reports both files have style drift (mostly long-line / chained-method-call wrapping). Verified by stashing the diff and re-running prettier on HEAD: **same files fail prettier on the pre-diff baseline.** Same drift exists on sibling untouched files (`views.ts`, `access.ts`, `crm.ts`, `note-targets.ts`). The repo's lint pipeline is broken for this package independent of this issue; this audit cannot block on it but it should be tracked. |
| Full unit suite (`npx jest --testTimeout 10000`) | PASS | 12 suites, **148 tests passed**, 0 failed, ~11s. |
| Adjacent-callers check | DEFECTS FOUND | See HIGH 1 below — all GraphQL-transport ops in `accessDispatchEntries` (CREATE_ROLE, CREATE_API_KEY, etc.) silently fail to populate the resolved map because their response shape has the mutation name as an extra layer between `parsed.result` and `id`. `viewsDispatchEntries` are all inner_tool transport — those are fine. `argsTransform` (only `CREATE_RELATION`) does not assume by-reference args — safe. `dispatch.build` callbacks are pure (do `{input: args}` or destructure for reshape) — safe. |

## Defects found

### HIGH 1 — id-extraction silently misses every GraphQL-transport mutation; chained access plans break (file: packages/twenty-mcp/src/tools/metadata.ts:541-556)

**What:** For `transport: 'graphql'` dispatch entries (every entry contributed by `accessDispatchEntries`: `CREATE_ROLE`, `UPDATE_ROLE`, `UPSERT_OBJECT_PERMISSION`, `UPSERT_FIELD_PERMISSION`, `INVITE_MEMBERS`, `CREATE_API_KEY`, `REVOKE_API_KEY`), the response wrapping flow is:

1. `data = await client.graphqlMutation(query, variables)` returns `json.data` from Twenty — for `mutation { createOneRole(...) { id label … } }` that is `{ createOneRole: { id: "<uuid>", label: "..." } }` (verified in `packages/twenty-mcp/src/twenty-mcp-client.ts:202` — `return json.data`).
2. `result = wrapGraphqlResult(data)` produces `result.content[0].text = JSON.stringify({ success: true, result: data })` — i.e. `{ success: true, result: { createOneRole: { id, ... } } }` (line 267-270).
3. The id-extractor (line 549-552) does:
   ```ts
   const id =
     (parsed.id as string | undefined) ??
     ((parsed.result as Record<string, unknown> | undefined)?.id as string | undefined);
   ```
   - `parsed.id` is undefined (top-level is `{success, result}`).
   - `parsed.result.id` is **also undefined** because the actual id sits at `parsed.result.createOneRole.id`, not `parsed.result.id`. The mutation name is an extra layer.
4. `resolved[m.key]` is therefore **never set** for any GraphQL CREATE op.
5. A downstream mutation that references `$<key>` for that op fails with `"unresolved placeholder $<key> — referenced mutation '<key>' either failed, was skipped, or does not precede this mutation in the plan"` — but the referenced mutation actually succeeded.

**Why HIGH:** This is the SAME bug class issue #1 was filed to fix, just on the GraphQL transport instead of the inner-tool transport. The whole point of the issue was "chained plans silently half-apply". A plan like:

```json
[
  { "key": "k1", "op": "CREATE_ROLE", "args": { "label": "Sales Lead" } },
  { "key": "k2", "op": "UPSERT_OBJECT_PERMISSION", "args": { "roleId": "$k1", "objectPermissions": [...] } }
]
```

…will fail at k2 with "unresolved placeholder $k1" even though k1 succeeded. The fix the implementer wrote handles `CREATE_VIEW → CREATE_VIEW_FIELD` (inner-tool transport, returns `{id, ...}`) but does not handle `CREATE_ROLE → UPSERT_OBJECT_PERMISSION` (GraphQL transport, returns `{<mutationName>: {id, ...}}`). Same partial-apply hazard, same user impact.

The plan's R3 actually identified this risk explicitly:

> **Failure mode 2 named in the plan**: "Inner-tool responses with non-standard id shapes are silently dropped: The id-extraction logic must handle both `{ id: "..." }` (some inner tools) and `{ success: true, result: { id: "..." } }` (GraphQL-transport tools)."

…but the implementer's hypothesised "GraphQL-transport tools return `{success: true, result: {id}}`" assumption is wrong. The GraphQL-transport wrapper itself wraps the data in `{success: true, result: ...}`, but the `result` payload is `{<mutationName>: {id, ...}}`, not `{id, ...}`. The plan got the mitigation half right (it correctly identified that two shapes exist) but encoded the wrong second shape.

**Evidence:**

- `packages/twenty-mcp/src/twenty-mcp-client.ts:165-203`: `graphqlMutation` returns `json.data` directly — for `mutation { createOneRole(...) { id … } }` this is `{createOneRole: {id, ...}}`.
- `packages/twenty-mcp/src/tools/metadata.ts:267-270`: `wrapGraphqlResult` puts that under `{success:true, result: data}`. So `parsed.result === {createOneRole: {id, ...}}`.
- `packages/twenty-mcp/src/tools/metadata.ts:549-552`: id-extractor only inspects `parsed.id` and `parsed.result.id`. Neither matches.
- **No test exercises the GraphQL-id-extraction path.** The new `placeholder resolved` test (line 510-545) uses `op: 'CREATE_VIEW'`, which is inner_tool transport, not graphql. The `unresolved placeholder` test exercises the failure path. The `skipped mutation` test uses `CREATE_VIEW` (inner_tool again).

**Suggested fix:** Either (a) walk one level deeper into `parsed.result` to find the first nested object with an `id`, e.g.:

```ts
const id =
  (parsed.id as string | undefined) ??
  ((parsed.result as Record<string, unknown> | undefined)?.id as string | undefined) ??
  // GraphQL transport: data is { <mutationName>: { id, ... } }
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
```

…or (b) thread a per-dispatch-entry "id selector" through `DispatchEntry` so each entry declares where its id lives in the response. (a) is the smaller change and matches the existing speculative-shape-trying style; (b) is more L1-correct ("schemas live in the wrapped system, not the wrapper") but a larger refactor.

Whichever fix is chosen, **add a new unit test that exercises a GraphQL-transport CREATE in a chained plan** — e.g., `CREATE_ROLE` returning `{createOneRole: {id: 'role-uuid'}}` followed by an `UPSERT_OBJECT_PERMISSION` referencing `$<role-key>`. Without that test, this defect class will silently regress in future refactors.

### MEDIUM 1 — placeholders only resolve when they're the WHOLE string; description doesn't say so (file: packages/twenty-mcp/src/tools/metadata.ts:455-459, 640)

**What:** The placeholder regex is anchored:

```ts
const simple = value.match(/^\$([a-zA-Z0-9_]+)$/);
```

Likewise `findUnresolved` uses the same `^…$` anchored regex. The contract is therefore "the entire string value must be exactly `$<key>` or `${<key>}`; embedded placeholders inside larger strings are passed through unchanged AND not flagged as unresolved."

The new tool description (line 640) says, verbatim: *"in any mutation's `args`, use `$<key>` or `${<key>}` to reference the `id` returned by a prior mutation … Example: if `CREATE_VIEW` has `key: "create_view__my_view"`, a subsequent `CREATE_VIEW_FIELD` can pass `viewId: "$create_view__my_view"`"*

It does **not** say "the placeholder must be the whole string." An LLM caller writing `"description": "Created via $my_key by the team"` will silently get the literal string passed through to Twenty, with no error. Twenty will store the literal `$my_key` text as the description — silent data corruption, exactly the L6 contract-drift class.

**Why MEDIUM (not HIGH):** Likely escapes most real plans because UUID-typed args (the actual usage) are ALWAYS the whole string. But it's still a latent description-vs-implementation mismatch and the description is the agent's only contract. R3 failure mode in the wild: an agent generating a `description` field that includes a placeholder. The agent never sees the regex; only the description.

**Suggested fix:** Either (a) extend the regex to find embedded placeholders (`/\$\{?([a-zA-Z0-9_]+)\}?/g`) — this would be a behaviour change and needs deliberate scoping — or (b) add to the description: *"Placeholders must be the entire string value (e.g. `viewId: \"$k1\"`, NOT `description: \"created via $k1\"`); embedded placeholders inside larger strings are not substituted and are passed through to Twenty literally."*

(b) is the smaller, less-risky option. It can be done in this same fix or a follow-up; it's not blocking.

**Draft follow-up issue (if filed separately):**

```
Title: metadata_apply_plan: clarify in description that placeholders must be the whole string

Body:
The placeholder regex in `metadataApplyPlan` is anchored (`^\$([a-zA-Z0-9_]+)$`), so only string values that are EXACTLY `$<key>` or `${<key>}` are substituted. Strings with embedded placeholders (e.g. `"created via $k1"`) silently pass through unchanged — neither substituted nor flagged as unresolved.

The tool description does not state this restriction. An LLM caller could reasonably interpret "use $<key> in any mutation's args" as supporting embedded placeholders. The most likely surface is an agent generating a `description` field referencing an id; the literal `$<key>` would land in the workspace.

Fix: add a sentence to the metadata_apply_plan description: "Placeholders must be the entire string value (e.g. viewId: \"$k1\", NOT description: \"created via $k1\")."

Optional follow-up: extend the regex to support embedded placeholders. Out of scope for the description-clarification fix.
```

### MEDIUM 2 — `applied[].result` retains the raw `ToolsCallResult` including any extracted-id payload, but never replays the placeholder-resolved `effectiveArgs` for audit (file: packages/twenty-mcp/src/tools/metadata.ts:558)

**What:** `applied.push({ key: m.key, op: m.op, result })` records the inner-tool response but does NOT record the resolved `effectiveArgs`. So if a caller later reconstructs the audit trail, they see "k2 was applied" but they cannot tell what `viewId` was actually sent — only the literal `$k1` text in the original `args`. For SchemaChangeAudit forensics ("what was the actual UUID?") this is recoverable from the inner tool's response, but only if the response includes it.

**Why MEDIUM:** This is forensic-quality, not correctness. It does not affect runtime behaviour. But for the plan-then-audit flow described in the original tool description ("caller stores a plan as a Twenty Note … `resumeFrom` list of mutation keys already applied per SchemaChangeAudit"), having the resolved args in the apply-plan output makes audit reconstruction one step easier.

**Suggested fix:** Add `resolvedArgs` (the post-substitution args) to the per-applied-mutation record, OR document that callers should reconstruct from the inner-tool response field set. Probably worth a follow-up issue, not blocking.

### MEDIUM 3 — `JSON.parse(text)` on inner-tool responses has no size cap (file: packages/twenty-mcp/src/tools/metadata.ts:548)

**What:** `JSON.parse(text)` runs on every inner-tool response without a size limit. A misbehaving inner tool that returned a multi-MB JSON blob would be fully parsed; a 100MB blob could OOM the proxy.

**Why MEDIUM:** The trust boundary is "we control both the proxy and Twenty". Inside that boundary, the risk is bounded. But it's not zero — a buggy inner tool returning a huge blob (e.g. find_<plural> with no limit) would get parsed unconditionally now where before this diff it was just stringified into the response and forwarded. The blast radius is the proxy's Node process.

**Suggested fix:** Cap the parse at, say, 1MB: `if (text.length > 1_000_000) skip` before `JSON.parse`. One line. Not blocking.

### LOW 1 — try/catch swallows ALL errors silently, including unexpected ones (file: packages/twenty-mcp/src/tools/metadata.ts:545-556)

**What:** The id-extraction `try { ... } catch { /* Non-JSON result — no id to extract. */ }` block silently swallows every error including programmer errors (e.g. `result.content` being undefined because the response shape evolved). The comment says "Non-JSON result" but the block also catches `TypeError: Cannot read properties of undefined (reading '0')` if `result.content` is somehow undefined.

**Why LOW:** Narrow scope (only one expression). Does not affect correctness today. Worth recording as a comment update so future readers understand the catch is intentionally broad, not just for `JSON.parse` errors.

**Suggested annotation (if added to plan's `## Implementation notes → Audit annotations`):**

> The `try { ... } catch {}` around id-extraction in metadata.ts:545-556 silently drops any error including `TypeError` from undefined `result.content`. Comment says "Non-JSON result" but the catch is broader. This is intentional (placeholder-id is best-effort and a missing id should not abort the whole apply-plan), but the comment understates the swallowed error class. A future reader could be tempted to narrow the catch to `SyntaxError` only, which would re-introduce a crash on shape changes.

### LOW 2 — `findUnresolved` returns the literal placeholder string (e.g. `"$k1"`), then the error message regex-strips dollar/braces from it; tightly coupled to placeholder format (file: packages/twenty-mcp/src/tools/metadata.ts:519-525)

**What:** The error message construction is:

```ts
error: `unresolved placeholder ${unresolvedPlaceholder} — referenced mutation '${unresolvedPlaceholder.replace(/^\$\{?([a-zA-Z0-9_]+)\}?$/, '$1')}' either failed, was skipped, or does not precede this mutation in the plan`
```

If anyone widens the placeholder regex to support embedded placeholders (the MEDIUM 1 fix), the `unresolvedPlaceholder` value will no longer be a bare `$<key>` and the `.replace(/^\$\{?...\}?$/)` regex will return the input unchanged, producing a confusing error like "referenced mutation '...embedded text $k1 here...'". Tight coupling between two regexes that look anchored-similar but are independent.

**Why LOW:** Only matters if/when the regex is widened. Foot-gun for the MEDIUM 1 fix.

**Suggested fix (if filed):** Have `findUnresolved` return both the matched location AND the extracted key, so the error message doesn't need to re-parse. Or memoise the key extraction inside `findUnresolved`.

## Adversarial pre-mortem (R3 against the diff)

Concrete failure modes the diff (not the plan) introduces in the next hour of real use:

1. **Chained access plan silently fails on the second mutation.** A user runs a "create role + grant permissions" plan: `[CREATE_ROLE k1 → UPSERT_OBJECT_PERMISSION k2 with roleId: "$k1"]`. k1 succeeds (role created in Twenty), k2 fails with "unresolved placeholder $k1 — referenced mutation 'k1' either failed, was skipped, or does not precede this mutation in the plan." User now has a dangling role and an apparently-correct plan. Same pattern as the original issue, on a different transport. (= HIGH 1.)

2. **Description field with embedded placeholder gets stored literally in Twenty.** Agent writes `args: { name: "My View", description: "Auto-generated for source $k0" }`. The wrapper passes the description through unchanged because the regex is `^…$`-anchored. Twenty stores the literal `$k0` as the description. No error surfaces. (= MEDIUM 1.)

3. **Inner tool returns `{success: false, ...}` with no top-level id; subsequent `$key` reference appears unresolved even though the inner-tool dispatch was "successful" from the wrapper's perspective.** Some inner tools wrap their response in `{success, result, message}` (e.g. on a soft-failure where the operation was rejected but the call succeeded). The wrapper's id-extractor walks `parsed.id ?? parsed.result.id`. If `success=false` and `result=null`, `resolved[m.key]` stays empty, and the next `$key` reference fails as unresolved — but the apply-plan ALSO doesn't fail at this mutation (because the `result.isError` flag from the inner tool may be false; the wrapper trusts the call). Result: `applied` contains a mutation that didn't actually do what the caller wanted, AND the next mutation fails. The wrapper has no way to surface that the upstream was a "soft-failure". (Adjacent to the existing partial-apply hazard but newly observable because of the placeholder-resolution chain.)

## Recommendations to supervisor

- **Block commit:** YES (one HIGH defect — chained access plans silently fail; reintroduces the exact bug class issue #1 was filed to fix, on the GraphQL transport instead of the inner-tool transport).
- **File new issues:** 0 immediately. The HIGH defect should be folded back into the same plan revision (re-implementer extends the id extractor to handle the GraphQL `{<mutationName>: {id}}` shape, and adds a unit test for it). The 3 MEDIUM defects are candidates for follow-up issues if not addressed in the round-2 revision; recommend MEDIUM 1 (description clarification) be folded in alongside the HIGH fix since it's a one-line description tweak.
- **Annotate to plan:** 2 (LOW 1, LOW 2) — both are foot-guns the next implementer should be aware of when extending the id-extraction or placeholder regex.
- **Confidence in this audit:** HIGH. The HIGH defect was traced end-to-end through the actual response shapes (`twenty-mcp-client.ts:202` returns `json.data`; the wrapper layers `{success, result: data}` over it; the id-extractor only looks two levels deep). The lint/prettier failures are confirmed pre-existing baseline (verified by stashing the diff and re-running on HEAD). The 148-test full suite passing reflects only what the existing tests cover — the GraphQL id-extraction path is not exercised by any test, which is why the HIGH defect ships green.

## Notes on the supervisor's specific concerns

For traceability, mapping the supervisor's eight thin-audit gaps to the audit findings:

1. **TypeScript** — Run, PASS. No defect.
2. **Lint** — Tooling broken at the package level (no `.oxlintrc.json`); prettier failures are pre-existing baseline. No new defect introduced by this diff. Tracked as a tooling issue separate from this fix.
3. **Test quality (mock shapes)** — **Coverage gap confirmed.** Tests cover the bare `{id}` shape only (lines 515, 578). The wrapped `{success: true, result: {<mutationName>: {id}}}` GraphQL shape is not exercised, and that's exactly where the HIGH defect lives.
4. **Adjacent-callers (argsTransform / build)** — Reviewed. `argsTransform` is value-spread only (`(args) => ({ relations: [args] })`), no mutation. `dispatch.build` callbacks all receive the new `effectiveArgs` object; they either spread (`{input: args}`) or destructure (`const {id, ...rest} = args`) — no by-reference assumption. SAFE.
5. **Description drift** — No contract test snapshots descriptions. SAFE on the test side. On the human side, the description does not constrain placeholder-position-in-string (= MEDIUM 1).
6. **Regex strictness vs description text** — Confirmed: `^…$`-anchored, description doesn't say so (= MEDIUM 1).
7. **DoS via uncapped JSON.parse** — Real but bounded by trust boundary (= MEDIUM 3).
8. **Error swallowing** — Intentional but the comment understates breadth (= LOW 1).
