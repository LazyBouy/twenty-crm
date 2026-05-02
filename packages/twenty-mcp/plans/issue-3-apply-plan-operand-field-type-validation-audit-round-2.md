# Audit report: metadata_apply_plan operand-for-field-type validation — round 2

> Plan: packages/twenty-mcp/plans/issue-3-apply-plan-operand-field-type-validation.md
> Round: 2
> Audited: 2026-05-02T20:30:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check | PASS | `npx nx typecheck twenty-mcp` clean (`tsc --noEmit` returned 0). |
| Lint (oxlint + prettier) | INCONCLUSIVE | `npx nx lint twenty-mcp` fails because `packages/twenty-mcp/.oxlintrc.json` is missing — same pre-existing infra gap that round 1 flagged as L-3. Targeted prettier check on the 6 changed files reports formatting drift in all 6 (but views.ts pre-existing drift was already large; this is an amplification of the same issue, not a new one). NOT a blocker for this audit because it's pre-existing infra. |
| Full unit suite | PASS | 13 suites, 164/164 tests, ~14s. Up from 158/12 in round 1 — 6 new tests were added (3 unit operand-validation tests, 1 layer-2 dispatcher tests x 2, 2 views-coverage tests). |
| Coverage test | PASS | `src/__tests__/coverage.test.ts` — 16 tests, including the toolName literal check that now resolves `get_field_metadata` and `get_view_filters` against the captured fixture. |
| Contract test | PASS | `src/__tests__/contract.test.ts` — 18 tests. |
| views-coverage test | PASS | `src/__tests__/views-coverage.test.ts` — 2 tests. Parser correctly extracts `FILTER_OPERANDS_MAP` from twenty-front's source via a balanced-brace + regex scan and asserts deep equality with the wrapper's `FIELD_TYPE_OPERAND_MAP`. |
| Integration round-trip | PASS (LIVE LOCAL STACK) | All 10 tests pass. The new test (`apply_plan CREATE_VIEW_FILTER with GREATER_THAN_OR_EQUAL on DATE_TIME is rejected by the proxy`) ran end-to-end against `http://localhost:4440` with destructive flag set. Auditor verified: (a) the field id `5c1f7b98-a454-413a-8ef3-f0dcf5820ca7` IS a real DATE_TIME field on the local workspace (queried `get_field_metadata` directly — returned `type: "DATE_TIME", name: "createdAt"`); (b) zero filter rows leaked into the database — auditor enumerated all 49 views and queried their filters, and found no `GREATER_THAN_OR_EQUAL` operand on `5c1f7b98-...` field. |
| Adjacent-callers check | OK | `assertOperandCompatible` is exported from views.ts and consumed by metadata.ts via a single import (`import { assertOperandCompatible, viewsDispatchEntries } from './views'`). Both layers call the same function. No drift surface. `FIELD_TYPE_OPERAND_MAP` is consumed by both wrapper handlers and the views-coverage test. server.ts registrations for `metadata_create_view_filter` and `metadata_update_view_filter` correctly point to the new validating handlers (server.ts:209-224). |

## Round-1 defect closure verification

| Round-1 defect | Round-2 status | Verified by |
|---|---|---|
| C-1: parser handles single-object shape, fail-opens on array | **CLOSED** | views.ts:107 `parsed = JSON.parse(text) as Array<{...}>`; views.ts:113 explicit `Array.isArray && length === 0` fail-closed; views.ts:117 `parsed[0]?.type` extraction. Tests at views.test.ts:7,13 use the array shape `JSON.stringify([{...}])` matching Twenty's actual response. Captured fixture at `get-field-metadata-sample.json` confirms array shape from live Twenty. |
| C-2: UPDATE_VIEW_FILTER lookup-by-id removed | **CLOSED** | The lookup path has been deleted entirely from `metadataUpdateViewFilter` (views.ts:349-369). The handler now fails closed when `args.fieldMetadataId` is absent and `args.operand` is present. The error message includes a clear remediation pointer (`Look up via metadata_query({kind: 'view_filters', args: {viewId: <viewId>}})`). |
| C-3: parser unpacks array, not object | **CLOSED** | Same fix as C-1 — the parser is now array-shaped throughout. There is no second parser anywhere; the lookup path was deleted. |
| H-1: FIELD_TYPE_OPERAND_MAP byte-for-byte matches twenty-front | **CLOSED** | Auditor verified by-hand comparison of all 21 field types against `packages/twenty-front/src/modules/object-record/record-filter/utils/getRecordFilterOperands.ts`. Every entry matches after expanding `...emptyOperands` (= `IS_EMPTY, IS_NOT_EMPTY`) and `...relationOperands` (= `IS, IS_NOT`). The `views-coverage.test.ts` mechanical verifier asserts the same equality at every CI run; auditor confirmed the test passes. |
| H-2: apply_plan layer fails closed for UPDATE_VIEW_FILTER without fieldMetadataId | **CLOSED** | metadata.ts:541-555 — Layer 2 explicitly checks `typeof effectiveArgs.fieldMetadataId !== 'string'` and writes a `failed` record with `requires fieldMetadataId` text, breaking the dispatch loop. Test at metadata.test.ts:788-818 exercises this path (asserts `failed.op === 'UPDATE_VIEW_FILTER'` AND `update_view_filter` was NOT called). |
| H-3: fixture entries CAPTURED, not synthesised | **CLOSED** | The implementer's claim ("named entries copied from numeric-key entries") was verified programmatically: `JSON.stringify(named.schema) === JSON.stringify(numbered.schema)` for both `get_field_metadata` and `get_view_filters`. The numeric-key entries are real captures from `learn_tools` against the local stack (the implementer's added `STATIC_INNER_TOOL_NAMES` entries: capture-inner-schemas.ts:50, 59). The named entries are byte-identical copies — no synthesis. The `$shape` field present in round 1 is correctly absent in round 2. The `forbiddenTopLevel` is `[]` (no curated invariants for read-only tools — appropriate). |
| H-4: tool descriptions for create/update_view_filter include the matrix + validation note | **CLOSED** | views.ts:425-440. Both `metadata_create_view_filter` and `metadata_update_view_filter` descriptions now include the full `OPERAND_MATRIX_DESCRIPTION` (the same matrix as `FIELD_TYPE_OPERAND_MAP`, rendered as a markdown bullet list) AND the explicit note "The wrapper validates operand-vs-field-type compatibility at runtime. Invalid combinations are rejected with an explicit error before reaching Twenty." `metadata_update_view_filter` additionally instructs "When updating `operand`, you MUST also supply `fieldMetadataId`." |
| L-1 (round 1): wire-routing test passes by accident | **CLOSED** | views.test.ts:11-29 `makeClient` now returns valid array-shaped `get_field_metadata` responses for the SELECT field type. The wire-routing test uses `operand: 'IS'` which is valid for SELECT, so validation passes legitimately (not via fail-open). |

## Defects found (round 2)

### CRITICAL

None.

### HIGH

None.

### MEDIUM — file as new GitHub issue

#### M-1. Integration test's hardcoded `DATE_TIME_FIELD_ID` is workspace-scoped — fails on a fresh workspace

**File:** `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:229`

**What:** The integration test uses `const DATE_TIME_FIELD_ID = '5c1f7b98-a454-413a-8ef3-f0dcf5820ca7'` — a literal UUID that the implementer captured from THEIR local workspace's `createdAt` field on the company object. On a fresh workspace (or any workspace where this exact UUID isn't a DATE_TIME field), the call to `assertOperandCompatible` would return `field metadata lookup returned no rows for fieldMetadataId 5c1f7b98-...`. The test would then fail with that error instead of the expected `Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME`. The implementer flagged this as Surprise #5 ("This ID will differ on other workspaces").

**Why medium (not high):** The implementer's own auditor-supplied claim is that the ID was captured from THIS local stack and is correct here. The auditor verified the field is real on this stack (queried `get_field_metadata` directly). The bug is latent for CI / fresh-workspace scenarios but does not block this commit on the current local stack. However, if CI ever runs the integration test on a different workspace (e.g., a docker-compose reset between runs), the test will silently fail in a confusing way.

**Why not low:** The integration test is the ONE assertion that proves the fix works end-to-end against real Twenty. If it becomes brittle due to workspace-scoped IDs, future maintainers may either skip it or "fix" it by lowering the assertion strength (a known anti-pattern). Better to make it self-discover the field id.

**Draft issue title:** `twenty-mcp: integration round-trip test self-discovers DATE_TIME field id instead of hardcoding`

**Draft issue body:**

The integration test in `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:229` uses a hardcoded UUID for the DATE_TIME field (`5c1f7b98-a454-413a-8ef3-f0dcf5820ca7` = `createdAt` on company on the local workspace where the test was authored). On any other workspace this ID will not be a DATE_TIME field — `get_field_metadata` returns no rows and the test fails with `field metadata lookup returned no rows for fieldMetadataId ...` instead of the expected `Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME` assertion.

Fix: have the test query `metadata_query({kind: "fields", args: {limit: 100}})` and find the first DATE_TIME field on any object, then use that id. This makes the test workspace-agnostic. Pseudo-code:

```ts
const fields = unwrap(await metadata.metadataQuery({ kind: 'fields' })).result;
const dateTimeField = fields.find((f: any) => f.type === 'DATE_TIME');
if (!dateTimeField) throw new Error('no DATE_TIME field found in workspace; reseed with stock data');
const DATE_TIME_FIELD_ID = dateTimeField.id;
```

This eliminates the workspace-scope coupling and makes the test runnable on any local docker-compose Twenty.

#### M-2. views-coverage parser hardcodes spread-operator names — silently drifts on new spreads

**File:** `packages/twenty-mcp/src/__tests__/views-coverage.test.ts:97-102`

**What:** The parser's `parseTwentyFrontMap` has two hardcoded checks:

```ts
if (/\.\.\.emptyOperands/.test(arrContent)) {
  operands.push('IS_EMPTY', 'IS_NOT_EMPTY');
}
if (/\.\.\.relationOperands/.test(arrContent)) {
  operands.push('IS', 'IS_NOT');
}
```

If twenty-front later adds a new spread (e.g., `...numericOperands` for NUMBER/RATING/CURRENCY), the parser silently misses those operands. The equality assertion would then fail in the wrapper-vs-front comparison — but with a misleading error message ("twenty-front has [X, Y] but wrapper has [X, Y, Z]" — pointing at the wrapper as the drifter when actually the parser is the drifter). The maintainer would either remove operands from the wrapper to make the test pass (introducing a real correctness bug) or eventually realise the parser is at fault.

**Why medium:** This is a foot-gun for the future, not an immediate defect. The current parser correctly handles the two existing spreads. But the parser's robustness assumption is "twenty-front will only ever use these two spread aliases" — which is not enforced anywhere. A long-term fix is to use the TypeScript compiler API (the plan suggested this as the primary approach; the implementer used the regex fallback).

**Draft issue title:** `twenty-mcp: views-coverage parser hardcodes spread-operator names — replace with TS compiler API`

**Draft issue body:**

The `views-coverage.test.ts` parser at lines 97-102 hardcodes regex checks for `...emptyOperands` and `...relationOperands` — the only two spread aliases in twenty-front's `FILTER_OPERANDS_MAP` today. If twenty-front adds a third alias (e.g., `...numericOperands`), the parser silently misses those operands and the equality assertion fails with a misleading error pointing at the wrapper.

Fix: replace the regex parser with the TypeScript compiler API approach (the plan's preferred path; implementer used the regex fallback). Use `typescript`'s `createSourceFile` + AST walk to find the `FILTER_OPERANDS_MAP` declaration node, walk each property, and resolve each spread by looking up the referenced const declaration in the same source file. This handles arbitrary spread names robustly.

Alternatively, expose `FILTER_OPERANDS_MAP` from `twenty-shared` so both packages import the same source. This requires a cross-package refactor (deferred in the plan's "Out of scope" section).

#### M-3. `metadataUpdateViewFilter` forwards `fieldMetadataId` into `update_view_filter` args, which is silently ignored by Twenty

**File:** `packages/twenty-mcp/src/tools/views.ts:368`

**What:** When `args.fieldMetadataId` and `args.operand` are both present and validation passes, the handler forwards `args` (including `fieldMetadataId`) to `update_view_filter` via `wrapInExecute`. But Twenty's `update_view_filter` Zod schema (`packages/twenty-server/src/engine/metadata-modules/view-filter/tools/view-filter-tools.factory.ts:63-83`) does NOT include `fieldMetadataId` — only `id`, `operand`, `value`, `subFieldName`. The captured fixture's JSON schema declares `additionalProperties: false`. Auditor verified live: Twenty silently accepts the extra property and proceeds normally (Zod's default is `passthrough`, not `strict` — the JSON-schema's `additionalProperties: false` is misleading; not enforced at runtime). So this is a **no-op effect** today.

**Why medium (not low):** Twenty's apparent acceptance is brittle. If the Twenty backend later switches its inner-tool Zod schemas to `.strict()` mode (a common Zod hardening change), the wrapper will start rejecting all UPDATE_VIEW_FILTER calls that supply `fieldMetadataId` with a strict-mode validation error. The wrapper's plan is asking agents to ALWAYS supply `fieldMetadataId` for operand updates; the wrapper then forwards an unsupported arg. This is an invisible coupling between the wrapper's contract and Twenty's runtime laxness.

**Why not low (cross-cutting flag worth filing):** The same pattern is L1 of the bug catalog ("schemas live in the wrapped system, not the wrapper"). Forwarding a wrapper-only arg to Twenty is a flavour of the same class. The fix is mechanical (one line: strip `fieldMetadataId` from args before forwarding).

**Draft issue title:** `twenty-mcp: metadataUpdateViewFilter strips fieldMetadataId before forwarding to inner tool`

**Draft issue body:**

`packages/twenty-mcp/src/tools/views.ts:368` — `metadataUpdateViewFilter` forwards args (including `fieldMetadataId`, which is in the wrapper's input schema) to Twenty's `update_view_filter` inner tool. Twenty's `update_view_filter` schema does NOT accept `fieldMetadataId` — only `id`, `operand`, `value`, `subFieldName` — but Twenty's Zod is `passthrough` mode by default, so the extra prop is silently ignored.

This is a **latent bug** that activates if Twenty hardens its Zod schemas to `.strict()` mode. Fix:

```ts
const { fieldMetadataId, ...forwardArgs } = args;
return wrapInExecute(client, 'update_view_filter', forwardArgs);
```

`fieldMetadataId` is needed by the wrapper for validation (looking up the field type) but is not part of the inner-tool contract. Drop it before forwarding.

Also adjust the wire-routing unit test in `views.test.ts:31-67` to assert the forwarded args do NOT contain `fieldMetadataId` (catches future regressions).

### LOW

#### L-1. Existing prettier drift expanded by ~150+ lines [COSMETIC] (`src/tools/views.ts`, 5 other files)

**What:** `npx prettier --check` on the 6 changed files reports formatting drift in all 6. Round 1 had ~136 lines of new drift; round 2 added more (the FIELD_TYPE_OPERAND_MAP table-style format, the OPERAND_MATRIX_DESCRIPTION template literal, the new test files). All can be auto-fixed via `npx prettier --write`.

**Why low — cosmetic:** Pure formatting; no functional impact. The repo's broader twenty-mcp prettier convention isn't enforced because `.oxlintrc.json` is missing (pre-existing infra gap from round 1's L-3). When `.oxlintrc.json` is added (a separate cross-cutting issue), this drift will surface in CI.

**Subcategory rationale:** No behaviour change, no test impact, no LLM-facing surface change. Pure whitespace.

**Suggested action:** backlog (cosmetic): run `npx nx lint twenty-mcp --configuration=fix` once `.oxlintrc.json` is added; resolution: defer until the lint-config issue is fixed (same supervisor decision as round 1's L-3).

#### L-2. Integration test asserts the wrapper rejected the operand BUT does NOT verify Twenty was never touched [TRIVIAL-IN-PLACE] (`src/__tests__/integration/round-trip.test.ts:231-264`)

**What:** The integration test's assertion is only on the wrapper's response: `parsed.failed?.op === 'CREATE_VIEW_FILTER'` + error text matches. The auditor manually verified zero filter rows leaked into the database (queried all 49 views' filters and confirmed zero `GREATER_THAN_OR_EQUAL` operands on the createdAt field). But the test itself doesn't include this verification step. If a future regression bypasses the wrapper-layer rejection and lets the bad operand through, the test would still pass (because Twenty would also reject — but with a different error — for invalid operand+type). The current assertion text-match doesn't catch that case.

**Subcategory rationale:** The fix is mechanical: add a second assertion after the `apply_plan` call that queries `metadata_query({kind: 'view_filters', args: {viewId: FAKE_VIEW_ID}})` (or any view) and asserts no row has the bad operand+field. Estimated 3-5 lines of test code, ~5 minutes to write and re-run.

**Suggested action:** add a follow-up `metadata_query` step at the end of the integration test asserting no filter row was written; estimated absorb time: 5min.

#### L-3. `views-coverage.test.ts` skip-on-missing-source path swallows the test silently [FOOT-GUN] (`src/__tests__/views-coverage.test.ts:31-34`)

**What:** If `TWENTY_FRONT_SOURCE` doesn't exist (e.g., a future twenty-front rename / move), the test does `it.skip(...)` instead of throwing. A silently skipped test in CI is invisible — the build passes. The whole point of this test is to detect drift; it cannot do so if it skips silently.

**Subcategory rationale:** Latent — only matters if someone moves twenty-front's source file. But the failure mode is severe (silent loss of the drift gate). The fix should be `throw new Error(...)` instead of `it.skip(...)`, which forces a loud rename-time alarm. This is a foot-gun classification because the bug only fires on a specific future change.

**Suggested action:** backlog (foot-gun): change `it.skip` to `throw new Error('twenty-front source file moved or missing — update TWENTY_FRONT_SOURCE path in views-coverage.test.ts')`; resolution: replace silent skip with loud failure.

## Adversarial pre-mortem (R3 against the diff)

1. **A future twenty-front change adds a new spread alias (e.g. `...numericOperands`) in `FILTER_OPERANDS_MAP`.** The views-coverage parser does NOT recognise the new spread, silently misses those operands, and reports a misleading drift between the wrapper and twenty-front. A maintainer trying to fix the test would likely remove operands from the wrapper to match the parser's output — introducing a real correctness regression. (M-2 above.)

2. **CI runs the integration test on a fresh / reset local docker-compose Twenty.** The hardcoded `DATE_TIME_FIELD_ID` UUID does not exist on the new workspace. The test fails with `field metadata lookup returned no rows`, not the expected operand-mismatch error. CI is red, the team disables the test, the wrapper-layer protection is no longer integration-verified. (M-1 above.)

3. **Twenty's backend hardens its `update_view_filter` Zod schema to `.strict()`.** The wrapper's `metadataUpdateViewFilter` continues to forward `fieldMetadataId` (a wrapper-only field). Twenty starts rejecting every UPDATE_VIEW_FILTER call that includes operand validation. Agents see "Unrecognized key(s) in object: 'fieldMetadataId'" — an opaque error far from the actual cause. The bug is invisible until Twenty bumps Zod schema strictness. (M-3 above.)

## Recommendations to supervisor

- Block commit: **NO**
- File new issues: **3** (M-1, M-2, M-3 — drafts in report)
- LOWs (3 total):
  - L-1 cosmetic → low-backlog (defer pending `.oxlintrc.json` infra fix)
  - L-2 trivial-in-place → absorb pre-commit (~5min: add a `metadata_query` post-rejection check in the integration test)
  - L-3 foot-gun → low-backlog
- Annotate to plan: 3 (the LOWs above, in the supervisor's annotation pass)
- Confidence in this audit: **high** — every round-1 critical/high defect was verified closed against the actual code AND against the live local stack. The byte-for-byte matrix equality was verified by hand AND by the new mechanical test. The fixture was verified to contain real captures (named entries are byte-identical copies of numeric captures, not synthesised). The integration test's DATE_TIME field is real on the current workspace, the test passes live, and zero leakage of bad filter rows was confirmed by direct database query. The MEDIUMs are real follow-up issues but do not block this fix from shipping.

This round is CLEAN — proceed to retrospective.
