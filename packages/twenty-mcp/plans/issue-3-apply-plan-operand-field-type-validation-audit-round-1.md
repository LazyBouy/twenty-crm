# Audit report: metadata_apply_plan operand-for-field-type validation — round 1

> Plan: packages/twenty-mcp/plans/issue-3-apply-plan-operand-field-type-validation.md
> Round: 1
> Audited: 2026-05-02T15:13:03Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check | PASS | `npx nx typecheck twenty-mcp` clean |
| Lint (oxlint + prettier) | INCONCLUSIVE | Repo missing `packages/twenty-mcp/.oxlintrc.json` (pre-existing infra gap; oxlint won't run). Prettier on edited files reports drift in 4 files, but the views.ts drift is partly pre-existing. The PR introduces ~136 new lines of prettier drift on top of ~140 pre-existing — see L-3 below. |
| Full unit suite | PASS | 158/158, 12 suites, ~12s |
| Adjacent-callers check | DEFECTS | Existing wire-level routing test for `metadataCreateViewFilter` / `metadataUpdateViewFilter` still passes by accident — the mock returns `'ok'` (non-JSON), the validator parses it as `undefined`, and silently fail-opens (see C-1, H-2). Existing `metadata_query — wire-level` test for `kind=view_filters` forwards `{limit: 10}` to `get_view_filters`, but Twenty's `get_view_filters` schema *requires* `viewId` — mock-only test, no live coverage. Server.ts registrations unchanged (handlers were already wired); no new register-call needed. |

## Defects found

### CRITICAL — blocks commit

#### C-1. `assertOperandCompatible` parses the wrong response shape — fail-opens against real Twenty

**File:** `packages/twenty-mcp/src/tools/views.ts:228-268`

**What:** The helper parses `JSON.parse(text)` and reads `parsed.type ?? parsed.result?.type`. But `get_field_metadata` in Twenty (`packages/twenty-server/src/engine/metadata-modules/field-metadata/tools/field-metadata-tools.factory.ts:171-193`) calls `this.fieldMetadataService.query({...})` which extends `TypeOrmQueryService<FieldMetadataEntity>` — `query()` returns `Promise<Entity[]>` (an array). The MCP layer then wraps the array as `{ content: [{ type: 'text', text: JSON.stringify([{type: 'DATE_TIME', ...}, ...]) }] }`. The parser sees an array, `parsed.type` is `undefined`, `parsed.result?.type` is `undefined`, and the helper returns `{ valid: true }` (fail-open) every time.

**Why critical:** This is the entire fix being non-functional in production. Issue #3's repro (DATE_TIME field with `GREATER_THAN_OR_EQUAL` operand → UI crash) will *still* slip through after this PR ships. The unit tests mock the helper with the wrong shape (an object with `type: 'DATE_TIME'`), so they pass — but no real Twenty response matches that shape. This is **L2 from `packages/twenty-mcp/CLAUDE.md`** ("Mocks pass when the spec passes — that's not correctness") and the **Tested-because-mock-passes** flawed framing called out in the same file.

**Evidence:**
- `packages/twenty-server/src/engine/metadata-modules/field-metadata/services/field-metadata.service.ts:38` — `extends TypeOrmQueryService<FieldMetadataEntity>`
- `node_modules/@ptc-org/nestjs-query-typeorm/src/services/typeorm-query.service.d.ts:44` — `query(query, opts?): Promise<Entity[]>`
- `packages/twenty-server/src/engine/api/mcp/services/mcp-tool-executor.service.ts:53` — `text: JSON.stringify(result)` where `result` is the raw return of `tool.execute(...)`.
- Mock in views.test.ts:82 returns `JSON.stringify({ type: 'DATE_TIME' })`. Twenty actually returns `JSON.stringify([{ type: 'DATE_TIME', id: '...', ... }])`.

**Suggested fix:** Update parser to accept both shapes:
```ts
const fieldType =
  (Array.isArray(parsed) ? (parsed[0] as { type?: string } | undefined)?.type : undefined) ??
  (parsed as { type?: string }).type ??
  ((parsed as { result?: { type?: string } }).result?.type) ??
  ((parsed as { result?: unknown[] }).result?.[0] as { type?: string } | undefined)?.type;
```
Plus: add a mock test that returns the array shape (matching Twenty's actual response) and assert validation still works. Plus: capture an actual `get_field_metadata` response into a fixture (per L1: capture, don't transcribe) and use it in tests.

#### C-2. `metadataUpdateViewFilter` lookup uses wrong arg name — `id` instead of `viewId`

**File:** `packages/twenty-mcp/src/tools/views.ts:320-324`

**What:** When `UPDATE_VIEW_FILTER` is called without `fieldMetadataId`, the handler tries to look up the existing filter row via:
```ts
client.toolsCall('execute_tool', {
  toolName: 'get_view_filters',
  arguments: { id: args.id },
});
```
But Twenty's `get_view_filters` (`packages/twenty-server/src/engine/metadata-modules/view-filter/tools/view-filter-tools.factory.ts:14-21`) has Zod schema `{ viewId: z.string().uuid() }` — **`viewId` is REQUIRED, and `id` is NOT a valid arg.** Twenty will reject the call with a Zod validation error (`tool execution failed`), which the wrapper catches in its `try { } catch { }` branch (line 326-339), returning `isError: true` with "failed to look up existing filter row".

**Why critical:** `UPDATE_VIEW_FILTER` calls without `fieldMetadataId` (the documented common case — "updating only operand or value") will *always* fail-closed in production. The plan's Layer 1 lookup path is non-functional. The plan body itself perpetuates this error: "look up from `metadata_query({kind: "view_filters", args: {id: ...}})`" — but the underlying inner tool only accepts `{viewId}`. There is no inner tool for "get one filter by id"; the closest is `get_view_filters({viewId})` which returns ALL filters on a view, then the caller filters by id locally.

**Evidence:**
- `packages/twenty-server/src/engine/metadata-modules/view-filter/tools/view-filter-tools.factory.ts:14-21` — `GetViewFiltersInputSchema = z.object({ viewId: z.string().uuid() })`
- `packages/twenty-server/src/engine/metadata-modules/view-filter/tools/view-filter-tools.factory.ts:99-114` — `execute: async (parameters: { viewId: string })`
- The fixture entry the implementer added (`get_view_filters` `$shape: "Read-only query: accepts {id?, viewId?, limit?}"`) is also wrong — that hand-authored description doesn't match Twenty's real schema.

**Suggested fix:** Either (a) document UPDATE_VIEW_FILTER as requiring an explicit `fieldMetadataId` (close the loophole — agents must look up the field id themselves), or (b) call `get_view_filters({viewId})` if the agent additionally supplies `viewId`, then locally filter by `args.id`. Option (a) is the simpler and safer fix. Option (b) requires `viewId` in the update args (currently absent from `metadataUpdateViewFilterInputSchema`).

The fixture's `$shape` summary for `get_view_filters` should also be corrected to reflect that `viewId` is required, not optional.

#### C-3. UPDATE_VIEW_FILTER lookup parser also expects wrong shape

**File:** `packages/twenty-mcp/src/tools/views.ts:356-363`

**What:** Even if C-2 were fixed and the lookup call succeeded, the parser does:
```ts
const lookupParsed = JSON.parse(lookupText) as { fieldMetadataId?: string } | { result?: { fieldMetadataId?: string } };
fieldMetadataId =
  (lookupParsed as { fieldMetadataId?: string }).fieldMetadataId ??
  (lookupParsed as { result?: { fieldMetadataId?: string } }).result?.fieldMetadataId;
```
But `get_view_filters` returns `filters.map((filter) => ({...}))` — an **array** of filter objects, not a single object (`view-filter-tools.factory.ts:99-114`). `parsed.fieldMetadataId` is undefined; `parsed.result` is undefined. Falls through to "could not determine fieldMetadataId" failure.

**Why critical:** Same root cause as C-1 (array vs object). Even after fixing C-2 (calling with `viewId`), the parser still doesn't extract anything useful. UPDATE_VIEW_FILTER without explicit `fieldMetadataId` remains broken.

**Suggested fix:** Walk the array, find the entry matching `args.id`, extract its `fieldMetadataId`. Combined with C-2 fix, this becomes:
```ts
const filtersArray = JSON.parse(lookupText) as Array<{ id?: string; fieldMetadataId?: string }>;
const match = Array.isArray(filtersArray) ? filtersArray.find((f) => f.id === args.id) : undefined;
fieldMetadataId = match?.fieldMetadataId;
```

### HIGH — blocks commit

#### H-1. FIELD_TYPE_OPERAND_MAP drifts from Twenty's actual ground-truth matrix

**File:** `packages/twenty-mcp/src/tools/views.ts:207-221`

**What:** The wrapper's matrix was hand-transcribed from the prose description in `view-filter-tools.factory.ts:34`. Twenty has a ground-truth matrix in `packages/twenty-front/src/modules/object-record/record-filter/utils/getRecordFilterOperands.ts:40-143` (`FILTER_OPERANDS_MAP`). Comparing:

| Field type | Wrapper says | Twenty's `FILTER_OPERANDS_MAP` |
|---|---|---|
| TEXT | IS, IS_NOT, CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY (no IS / IS_NOT) |
| EMAILS | IS, IS_NOT, CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| FULL_NAME | IS, IS_NOT, CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| ADDRESS | (missing — fail-open) | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| LINKS | (missing — fail-open) | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| PHONES | (missing — fail-open) | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| RAW_JSON | (missing — fail-open) | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| FILES | (missing — fail-open) | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| RATING | (missing — fail-open) | IS, GTE, LTE, IS_EMPTY, IS_NOT_EMPTY |
| ACTOR | (missing — fail-open) | CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY |
| UUID | (missing — fail-open) | IS |
| TS_VECTOR | (missing — fail-open) | VECTOR_SEARCH |

**Why high:** Two consequences:
1. **False negatives (over-permissive):** If C-1 were fixed and validation actually ran, the wrapper would *accept* `operand: 'IS'` for a TEXT field — but Twenty's UI doesn't render IS/IS_NOT operands for TEXT, so the original UI-crash bug class is preserved. Same for EMAILS, FULL_NAME.
2. **Fail-open expansion:** Eight Twenty field types (ADDRESS, LINKS, PHONES, RAW_JSON, FILES, RATING, ACTOR, UUID, TS_VECTOR) aren't in the wrapper's matrix at all. Per the wrapper's "fail-open for unknown types" policy, ANY operand on these fields passes validation. So the bug is preserved for nine field types.

This is the same bug class as the original issue — different field types, same UI crash. Filing a flag-fix that closes one corner of the matrix while leaving the rest open is L4 from CLAUDE.md ("Uncertain pending verification = broken until proven").

**Suggested fix:** Pull `FILTER_OPERANDS_MAP` from `packages/twenty-front/src/modules/object-record/record-filter/utils/getRecordFilterOperands.ts` as the source of truth. Either: (a) re-export it from `twenty-shared/utils/filter` so the wrapper can import; or (b) capture it as a fixture during the inner-schema capture script. Don't hand-transcribe.

#### H-2. apply_plan dispatcher silently skips validation when fieldMetadataId is absent for UPDATE_VIEW_FILTER

**File:** `packages/twenty-mcp/src/tools/metadata.ts:544-558`

**What:** The pre-dispatch validation is gated on:
```ts
if (
  (m.op === 'CREATE_VIEW_FILTER' || m.op === 'UPDATE_VIEW_FILTER') &&
  typeof effectiveArgs.operand === 'string' &&
  typeof effectiveArgs.fieldMetadataId === 'string'   // ← gate
) { ... }
```

For `UPDATE_VIEW_FILTER`, `fieldMetadataId` is optional (per the schema and per the plan's failure-mode #3). When an agent submits a plan with `{op: 'UPDATE_VIEW_FILTER', args: {id, operand: 'GREATER_THAN_OR_EQUAL', value: ...}}` (no `fieldMetadataId`), the apply_plan dispatcher SKIPS validation and forwards the call to `update_view_filter` directly. Layer 2 (apply_plan) is the layer that the original incident hit; this gap means the original bug class is **not closed** for UPDATE_VIEW_FILTER through apply_plan.

The plan called this out explicitly in failure-mode #3 (line 189) and proposed Layer 1 mitigation. But the implementation doesn't replicate the lookup-by-filter-id fallback at Layer 2; it silently skips. Even if the Layer 1 implementation were correct (it isn't — see C-2/C-3), the apply_plan path bypasses it.

**Why high:** The original incident was in `metadata_apply_plan`, not the direct handler. The proposed fix has Layer 1 (direct handler) and Layer 2 (apply_plan) per the plan's "Out of scope" #3 ("Both layers MUST be implemented; this is not an acceptable split"). Layer 2 is partially implemented — only the `fieldMetadataId`-present case is wired.

**Suggested fix:** Either (a) at the apply_plan layer, fail-closed with an explicit error when UPDATE_VIEW_FILTER lacks `fieldMetadataId` ("metadata_apply_plan: UPDATE_VIEW_FILTER must include `fieldMetadataId` to enable operand validation; the direct `metadata_update_view_filter` handler can omit it but apply_plan does not support the lookup fallback"), or (b) re-route apply_plan UPDATE_VIEW_FILTER through the direct `metadataUpdateViewFilter` handler so the lookup fallback runs. Option (a) is simpler and forces agents to be explicit.

#### H-3. Fixture entries hand-authored without capture; `get_view_filters` $shape is wrong

**File:** `packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json:9602-9611`

**What:** The implementer added two entries to the fixture to satisfy the coverage test:
```json
"get_field_metadata": {
  "$shape": "Read-only query: accepts {id?, objectMetadataId?, limit?}. ...",
  "schema": null,
  "forbiddenTopLevel": []
},
"get_view_filters": {
  "$shape": "Read-only query: accepts {id?, viewId?, limit?}. ...",
  "schema": null,
  "forbiddenTopLevel": []
}
```

The `get_view_filters` `$shape` is wrong: Twenty's actual schema (`view-filter-tools.factory.ts:14-21`) is `z.object({ viewId: z.string().uuid() })` — `viewId` is **required**, and `id` / `limit` are **not accepted**. The hand-authored summary contradicts the deployed system.

The fixture file's `$comment` (line 2) explicitly says: "Refresh via scripts/capture-inner-schemas.ts when Twenty's server changes." Capture, don't hand-author. **L1 from CLAUDE.md:** "Schemas live in the wrapped system, not the wrapper. Capture; don't transcribe."

**Why high:** Synthesising fixture entries to satisfy a regex-based coverage test — without verifying against Twenty — is exactly the bug class the coverage test exists to prevent. The coverage test passing here is L1 violated AND L4 violated ("Uncertain pending verification = broken until proven"). It also creates a false sense of safety: "the coverage test passed, so my new tool names exist on Twenty" — but the entries were synthesised, so the coverage test now passes regardless of whether the names are valid.

**Suggested fix:** Run `npx dotenv -e .env.local -- npx tsx scripts/capture-inner-schemas.ts` against a local Twenty stack and let the script fill in the schemas + forbiddenTopLevel for `get_field_metadata` and `get_view_filters`. If the local stack is unavailable, defer the fix until it is; do not synthesise.

#### H-4. Description-vs-handler contract drift on `metadata_create_view_filter`

**File:** `packages/twenty-mcp/src/tools/views.ts:444-450`

**What:** The handler now performs operand-vs-field-type validation that can return `isError: true` with "Operand X is not valid for Y field". The tool description (line 447) does not mention this. Agents reading the description see only the operand enum and a generic "Filter values follow Twenty's typing rules per operand + field type" — no mention that the wrapper enforces the matrix, no mention of the error format, no mention of fail-open for unknown types.

This is **L6 from CLAUDE.md**: "Tool descriptions ARE the contract for LLMs. Audit them when schemas change."

**Why high:** Agents will not anticipate the validation error mode. A retry loop on `isError: true` may loop forever (the agent reads the operand enum from the description, picks one that matches the enum, retries — same operand, same error). The description must say which operands map to which field types so the agent can self-correct without an infinite loop.

**Suggested fix:** Update the description on `metadata_create_view_filter` to include the per-field-type operand allow-list (the same matrix as in `view-filter-tools.factory.ts:34`), and a note that the wrapper rejects mismatches with an explicit error. Same for `metadata_update_view_filter`.

### MEDIUM — file as new GitHub issue

#### M-1. No integration smoke test was run; deferred per "local Twenty stack not reachable"

**File:** plan's Implementation notes step 7

**What:** The plan's test plan included an integration round-trip test that exercises the fix against a real Twenty. The implementer reported "DEFERRED — local Twenty stack not reachable". Combined with C-1, C-2, C-3, H-3 — every defect in this audit could have been caught by a single live integration run against Twenty (the response-shape mismatch would surface immediately as a fail-open in a context that should fail-closed). The fix shipped without ever exercising the real failure mode it's supposed to close.

**Draft issue title:** "twenty-mcp: integration smoke for `apply_plan` operand validation deferred — re-run against local Twenty pre-merge"

**Draft issue body:** The PR for issue #3 (operand-for-field-type validation in apply_plan) did not run the integration round-trip test because the local Twenty stack was not reachable at implementation time. The unit tests pass with mocked responses that do not match Twenty's actual `get_field_metadata` response shape (Twenty returns `Entity[]`; tests mock `{type: 'DATE_TIME'}`). The fix needs to be re-validated end-to-end before being trusted in production. Expected: run the round-trip test against a local docker-compose Twenty (`TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- npx jest --testPathPattern='round-trip.test.ts' --config jest.config.ts`) and confirm: (a) DATE_TIME field with GREATER_THAN_OR_EQUAL operand is rejected with the expected error before reaching Twenty; (b) the rejected filter row is NOT in the database after the apply_plan call; (c) DATE_TIME field with IS_AFTER passes through normally.

#### M-2. The matrix-coverage test does not catch enum drift in Twenty's `ViewFilterOperand`

**File:** `packages/twenty-mcp/src/__tests__/views.test.ts:170-206`

**What:** The test hand-codes the enum values:
```ts
const allOperands = ['IS', 'IS_NOT', 'IS_NOT_NULL', ...];
```
This is a transcription, not an import. If Twenty adds a new operand to its `ViewFilterOperand` enum (e.g. `WITHIN`) without updating this test, the wrapper's enum (line 53) might also be missing it (also a transcription) — and the coverage test would still pass. The plan's failure-mode #2 explicitly relies on this test catching enum drift; the test doesn't actually do that.

**Draft issue title:** "twenty-mcp: views.test.ts operand-coverage test transcribes the enum instead of importing it"

**Draft issue body:** The `operand matrix coverage` test in `views.test.ts:170-206` hand-codes the list of operand values rather than importing the Zod enum from `views.ts`. To close the failure-mode #2 from the issue-3 plan ("the matrix becomes stale when Twenty adds new field types or operands"), the test should `import { ViewFilterOperand } from '../tools/views'` (or wherever the enum lives) and iterate `ViewFilterOperand.options`. Then a future operand add to the enum will automatically be checked against the matrix. Bonus: also import `FILTER_OPERANDS_MAP` from twenty-shared (or capture it as a fixture) and assert the wrapper's matrix is a subset of Twenty's matrix per field type.

#### M-3. The coverage test's regex doesn't catch validation tool calls if they're moved behind a variable

**File:** `packages/twenty-mcp/src/__tests__/coverage.test.ts:62-74`

**What:** The implementer noted in Surprises #1 that they had to add fixture entries because the new code uses `toolName: 'get_field_metadata'` as a string literal. The coverage test's regex `/toolName\s*:\s*['"]([a-zA-Z_][\w]*)['"]/g` only catches literals. If a future maintainer refactors `assertOperandCompatible` to extract the tool name into a variable (reasonable cleanup: `const FIELD_METADATA_LOOKUP_TOOL = 'get_field_metadata'; ... toolName: FIELD_METADATA_LOOKUP_TOOL`), the coverage test would silently stop checking the reference. metadata.ts already does this via `route.innerToolName` — those references are not coverage-checked. This is a structural blind spot.

**Draft issue title:** "twenty-mcp: coverage test misses inner-tool references behind variables"

**Draft issue body:** `coverage.test.ts:extractInnerToolNames` only matches `toolName: '<literal>'`. References via local variables / object lookups bypass the check. Consider adding a manual allow-list of "known references that aren't string literals" the test cross-checks (a reverse lookup: for every entry in the fixture's `tools` map, assert it's referenced by either a literal OR an explicit allow-list entry in a test-side config). Alternatively, change the coverage approach to runtime — actually call the tool surface and trace which inner names get dispatched.

### LOW — annotate to Implementation notes

#### L-1. Existing wire-routing test passes by accident — mock returns 'ok' (non-JSON); validation fail-opens silently

**File:** `packages/twenty-mcp/src/__tests__/views.test.ts:5, 25-50`

**What:** The pre-existing `views — wire-level routing` parametrized test passes `operand: 'IS'` and the mock returns `{ content: [{ type: 'text', text: 'ok' }] }`. After this PR's changes, the new `assertOperandCompatible` is called first; it tries `JSON.parse('ok')`, fails, returns `{ valid: true }` (fail-open). The test then sees `create_view_filter` was called and passes. The test passing tells us nothing about whether validation runs correctly.

**Suggested annotation:** "L-1: views.test.ts wire-routing test continues to pass because validation fail-opens silently on non-JSON mock response. The mock at line 5 should return a JSON-shaped body so the new validation actually exercises in this test."

#### L-2. apply_plan dispatcher comment about validation gating is misleading

**File:** `packages/twenty-mcp/src/tools/metadata.ts:539-547`

**What:** The comment says "for UPDATE_VIEW_FILTER it is optional but the direct handler in views.ts handles the lookup — here we only validate when both are provided in the plan args." This makes the design sound deliberate. In reality, Layer 2 is silently bypassed for the most common UPDATE_VIEW_FILTER case (operand-only update). See H-2.

**Suggested annotation:** "L-2: metadata.ts:539-547 — comment reads as 'design choice'; actually Layer 2 has a coverage gap for UPDATE_VIEW_FILTER without `fieldMetadataId`. Tracking H-2."

#### L-3. PR introduces ~136 lines of new prettier drift in views.ts; `.oxlintrc.json` is missing

**File:** `packages/twenty-mcp/src/tools/views.ts` + missing `.oxlintrc.json`

**What:** The FIELD_TYPE_OPERAND_MAP (line 207-221) uses an aligned table-style format that exceeds prettier's 80-col limit; prettier wants to expand each entry. Pre-existing prettier drift in views.ts was ~140 diff lines; the PR adds another ~136 lines worth. Plus, `npx nx lint twenty-mcp` fails because `packages/twenty-mcp/.oxlintrc.json` is missing — but every other package has one. This is a pre-existing infra gap, not introduced by this PR; flagging for visibility.

**Suggested annotation:** "L-3: prettier drift +136 lines (table-style operand map); `.oxlintrc.json` missing in twenty-mcp (pre-existing infra)."

## Adversarial pre-mortem (R3 against the diff)

1. **Agent submits CREATE_VIEW_FILTER for a TEXT field with operand 'IS'.** The wrapper's matrix accepts IS for TEXT (incorrect — Twenty's UI doesn't render IS for TEXT). The wrapper passes the call through. Twenty persists the filter row. The view page crashes on next render. Bug class identical to issue #3.

2. **Agent submits UPDATE_VIEW_FILTER with `{id, operand: 'GREATER_THAN_OR_EQUAL'}` (no fieldMetadataId)** through `apply_plan`. The dispatcher's gating skips validation entirely (H-2). The call goes through to Twenty. UI crashes when the view loads.

3. **Agent submits CREATE_VIEW_FILTER for a real DATE_TIME field with GREATER_THAN_OR_EQUAL** (the literal repro from issue #3). The wrapper calls `get_field_metadata({id})`. Twenty returns `[{type: 'DATE_TIME', ...}]` (array). Parser sees `parsed.type === undefined`, fail-opens. Validation NEVER FIRES. The original bug ships unfixed (C-1).

## Recommendations to supervisor

- Block commit: **YES**
- File new issues: **3** (M-1, M-2, M-3 — drafts in report)
- Annotate to plan: **3** (L-1, L-2, L-3)
- Confidence in this audit: **high** — the C-1/C-2/C-3 array-vs-object response-shape issue and H-1 matrix drift are verified directly against Twenty's source code (factories, services, frontend `FILTER_OPERANDS_MAP`). The unit suite passes only because the mocks reflect the wrong shape.

The fix needs to be revised: parser needs to handle array shape; UPDATE_VIEW_FILTER lookup needs to use `viewId` not `id` and walk the array; the matrix needs to be sourced from Twenty's `FILTER_OPERANDS_MAP` not hand-transcribed; the apply_plan layer needs to handle UPDATE_VIEW_FILTER without fieldMetadataId; the descriptions need to mention validation. After re-implementation, run the integration round-trip test live before round 2 audit.
