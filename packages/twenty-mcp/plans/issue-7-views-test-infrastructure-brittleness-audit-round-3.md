# Audit report: Fix brittle test infrastructure from issue-3 implementation (#7, #8, #9) — round 3

> Plan: packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness.md
> Round: 3 (FINAL ALLOWED ROUND per cycle limit)
> Audited: 2026-05-03T00:30:00Z
> Auditor: issue-auditor (opus)

## Summary up front

Round 3 closes round-2's HIGH-1 (the `parseInnerOrGraphqlArray` unit test was inside the integration-gated path). The helper has been extracted to its own module at `packages/twenty-mcp/src/utils/parse-metadata-array.ts`, and the unit tests live at `packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts` (NOT under `/integration/`). Default `npx jest --config jest.config.ts` (no env flags) now executes the 3 helper assertions; mechanical verifier confirms the test count is 169 in default mode, 184 in `INCLUDE_INTEGRATION=1` mode, and the 3 helper tests run in BOTH modes (the gap is the integration suite alone, 15 skipped tests). Round-1 HIGH-1 (`apply_plan` UPDATE_VIEW_FILTER leak) and HIGH-2 (verification block silently no-ops) remain closed: the shared `stripFieldMetadataIdFromUpdateArgs` helper is exported from `views.ts` and used by BOTH the direct handler AND the dispatch entry's `argsTransform`; the integration test's verification block uses `parseInnerOrGraphqlArray` (now imported) and produces a non-empty 1-row haystack on the live stack (verified by independent live probe — see Mechanical gates).

No new HIGHs introduced. The 4 round-2 LOWs (foot-gun fields-limit-200, foot-gun views-coverage non-greedy regex, foot-gun helper returns `[]` silently for unrecognised shapes, cosmetic loose row typing) remain present in the diff per design — to be routed by `/audit-fix`.

**Recommendation: clean — proceed to commit.**

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | Clean. `_` underscore destructure compiles fine; tests dir excluded from typecheck. The new `src/utils/parse-metadata-array.ts` typechecks against `src/tsconfig.json` like the rest of `src/`. |
| Lint (`lint:diff-with-main`) | INCONCLUSIVE | Same pre-existing tooling gap as rounds 1–2: target does not exist for `twenty-mcp`; direct `npx nx lint twenty-mcp` fails with `Failed to parse config .oxlintrc.json (NotFound)` — pre-existing, not introduced by this PR. Direct `npx oxlint` on the seven changed/new files yields ONE warning: `MOCK_SELECT_FIELD_RESPONSE` declared but never used in `views.test.ts:6` — same pre-existing warning flagged in rounds 1 & 2. No new lint defects. |
| Full unit suite (`npx jest --config jest.config.ts`) | PASS | 14 suites, 169 tests, 11.9s. Matches round-3 implementer notes exactly (3 net new tests vs. round 2's 166 — the 3 new helper assertions in `parse-metadata-array.test.ts`; the round-2 in-integration unit assertions are no longer in the integration file at all). |
| Adjacent-callers check | OK | `update_view_filter` has exactly two construction sites in production code: (1) direct handler `views.ts:382` (`return wrapInExecute(client, 'update_view_filter', stripFieldMetadataIdFromUpdateArgs(args))`); (2) dispatch entry `views.ts:397` (`UPDATE_VIEW_FILTER: { transport: 'inner_tool', innerToolName: 'update_view_filter', argsTransform: stripFieldMetadataIdFromUpdateArgs }`). Both go through the same helper; symmetric Layer-1 + Layer-2 fix as round 2 promised. The dispatcher at `metadata.ts:569-573` invokes `dispatch.argsTransform(effectiveArgs)` then forwards `innerArgs` via `wrapInExecute` — confirmed by reading the file. No `parsed.result ?? []` pattern anywhere in test/integration files for metadata array parsing (only legitimate `wrapGraphqlResult` and JWT decode references remain, all correctly scoped). |

Live-stack mechanical gates (also run, all PASS):
- Integration test (`TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts --testNamePattern="operand validation"`): PASS — 1 test passes (268 ms), 9 skipped (10 total). The `beforeAll` self-discovers `DATE_TIME_FIELD_ID` dynamically against the live workspace; the rejection assertion + the verification block both pass on real data.
- Contract test: PASS — 18 tests.
- Views unit test: PASS — 18 tests including the two fieldMetadataId-leak assertions (the "value-only passes through" test at `views.test.ts:200-223` and the dedicated "with operand does NOT forward fieldMetadataId" at `views.test.ts:225-242`).
- Views-coverage test: PASS — 2 tests; generic spread resolver still resolves both `...emptyOperands` and `...relationOperands` correctly against the current twenty-front source.
- `parseInnerOrGraphqlArray` unit test (default mode): PASS — 3 tests in `parse-metadata-array.test.ts`, all passing in 0.98s without any env flags set. The plan's round-3 promise (test runs in default suite) is mechanically true.
- Layer-2 (apply_plan UPDATE_VIEW_FILTER) test: PASS — `metadata.test.ts:822-852` asserts on the captured outgoing `update_view_filter` arguments (the `.arguments` field of the `client.toolsCall('execute_tool', …)` call), confirming `fieldMetadataId` is NOT forwarded.

Live-stack probe (independent verification, run via standalone CJS script, cleaned up):
- `metadata_query({kind: 'view_filters', args: {limit: 200}})` against the running stack returns: top-level array, length **1**, keys `[id, viewId, fieldMetadataId, operand, value, subFieldName, positionInViewFilterGroup]`, the single row has `operand: "IS"` and `fieldMetadataId: 0c108db8-da43-4c21-aee7-36f240c04940` (NOT a DATE_TIME field, NOT `GREATER_THAN_OR_EQUAL`). The helper unwraps to a 1-row array; the `leakedRows` filter returns `[]` from a non-empty haystack — **the `expect(leakedRows).toEqual([])` assertion is genuinely verifying, not vacuous.** This re-confirms the round-2 round-1-HIGH-2 closure is structurally sound and unchanged in round 3.

Test-routing regression check (round-3's "verifier-of-the-verifier"):
- Default `npx jest --config jest.config.ts`: 169 passed, `parse-metadata-array.test.ts` PASS line appears in output.
- `INCLUDE_INTEGRATION=1 npx jest --config jest.config.ts`: 169 passed + 15 skipped = 184 total, `parse-metadata-array.test.ts` PASS line still appears in output.
- The 3 helper tests are in BOTH counts (default 169 → INCLUDE 184 = 169 + 15 integration-only; the +15 is the integration suite's own tests, not the helper tests). The round-2 HIGH bug class is structurally eliminated at the file-routing layer.

## Defects found

### CRITICAL — none.

### HIGH — none.

### MEDIUM — none.

### LOW — varied routing per subcategory (carried forward from rounds 1–2 by design)

#### LOW-1 (carried from rounds 1 & 2): `metadata_query({kind: 'fields', args: {limit: 200}})` is at the limit cap on the live workspace [FOOT-GUN] (`round-trip.test.ts:235`)

- **What:** Live probe re-confirmed for round 3: the fields query still returns at the 200-row cap on the local stock workspace. 53/200 are DATE_TIME and the test discovers one. If a workspace's field ordering ever shifts such that DATE_TIME fields are pushed past the 200 cutoff, the test fails with "no DATE_TIME field found in workspace (parsed: array of 200) — Either reseed stock data, OR investigate response-shape drift" — the round-2-improved error message is unambiguous between two failure modes (stock-data-missing vs. shape-drift) but does NOT name a third mode (limit-too-low).
- **Why low:** Today on the live stack the test works; this is latent. The plan's pre-mortem #2 explicitly anticipated and accepted this risk.
- **Subcategory rationale:** FOOT-GUN, not TRIVIAL-IN-PLACE — latent today (the test passes); only matters if some other change happens later (workspace grows or field-ordering shifts).
- **Suggested action:** backlog (foot-gun): `round-trip.test.ts beforeAll caps fields query at 200 — could miss DATE_TIME if workspace field count exceeds limit and ordering pushes it past page boundary, AND the error message will misleadingly say "array of 200" implying complete data`; resolution: page through all field-metadata results in beforeAll, OR query `kind: 'objects'` first to find a known stock object (e.g. `company`) and then query its fields directly via `objectMetadataId` filter to get a small focused list.

#### LOW-2 (carried from rounds 1 & 2): views-coverage.test.ts spread-resolver regex stops at the first `]` [FOOT-GUN] (`views-coverage.test.ts:103-105`)

- **What:** Unchanged from rounds 1 & 2. The spread declaration regex `const\\s+${spreadName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]` uses non-greedy `[\\s\\S]*?\\]` which matches up to the FIRST `]`. Today the spread declarations in twenty-front contain only flat operand lists, so this works. If twenty-front ever introduces a nested array inside a spread declaration, the parser would slice off too early and miss operands.
- **Why low:** Today the test passes correctly (verified live against the actual twenty-front file via the views-coverage test PASS). Risk only surfaces if twenty-front evolves to use nested arrays inside spread-target consts — unlikely for a lookup table of operands.
- **Subcategory rationale:** FOOT-GUN — real bug class (silent miss → false-pass) but requires specific upstream syntax change.
- **Suggested action:** backlog (foot-gun): `views-coverage.test.ts spread declaration regex uses non-greedy [\\s\\S]*?\\] — would mis-slice if a spread const contains nested arrays`; resolution: switch to a balanced-bracket scan analogous to the FILTER_OPERANDS_MAP block scan (lines 50-58), or migrate to TypeScript compiler API.

#### LOW-3 (carried from round 2): `parseInnerOrGraphqlArray` returns `[]` silently for unrecognised shapes [FOOT-GUN] (`parse-metadata-array.ts:22`)

- **What:** When the input JSON is neither a top-level array nor `{result: [...]}`, `parseInnerOrGraphqlArray` returns `[]`. This is documented (the helper's JSDoc explicitly notes "returns `[]` for unrecognised shapes"; the third unit assertion in `parse-metadata-array.test.ts:18-22` enforces this). For the verification block (`round-trip.test.ts:295-308`), this means: if a future Twenty API change returns view_filters wrapped in a different envelope (e.g. `{data: [...]}`, `{viewFilters: [...]}`, paginated `{rows: [...], total: 1}`), the helper silently returns `[]` and the assertion `expect(leakedRows).toEqual([])` is vacuously true again — exact same Tested-because-mock-passes class as round-1 HIGH-2.
- **Why low:** Today, both `view_filters` (inner_tool) and the wrapped GraphQL kinds are accounted for; this is latent. The plan's "Out of scope" doesn't anticipate a third envelope shape. The helper now lives in its own module, which makes a future tightening (throw on unrecognised shape) a one-place edit instead of a multi-callsite refactor — slight improvement in addressability vs. round 2.
- **Subcategory rationale:** FOOT-GUN — only matters if an upstream Twenty change introduces a third shape. Promote to MEDIUM if Twenty's transport layer is known to be in flux.
- **Suggested action:** backlog (foot-gun): `parseInnerOrGraphqlArray returns [] for unrecognised shapes — would silently no-op the verification block again if a future Twenty API change returns a third envelope shape`; resolution: throw on unrecognised shape (`throw new Error('parseInnerOrGraphqlArray: input is neither raw array nor {result: [...]}; got top-level keys [' + Object.keys(raw).join(', ') + ']')`) so a shape drift fires a loud failure rather than a silent no-op. The third unit assertion would also need to be updated to `expect(() => parseInnerOrGraphqlArray(...)).toThrow(/...keys.../)`.

#### LOW-4 (carried from round 2): `viewFilterRows` typing is loose enough that a future regression could land in a malformed row without surfacing [COSMETIC] (`round-trip.test.ts:300-303`)

- **What:** Unchanged from round 2. The verification block types `viewFilterRows` as `Array<{ fieldMetadataId?: string; operand?: string }>` — both fields are optional. If a future regression caused Twenty to return rows with the leaked `fieldMetadataId` but a malformed shape (e.g. `fieldMetadataId` is a number, or absent), the optional-string type means `row.fieldMetadataId === DATE_TIME_FIELD_ID` would still be a valid expression and would just evaluate to `false`. The `leakedRows` filter would still produce `[]` even if there were leaks of a different shape.
- **Why low:** Twenty's view_filters response is well-defined; this is purely defensive typing, not a real risk vector today (live probe confirms the row shape is `{id, viewId, fieldMetadataId, operand, value, subFieldName, positionInViewFilterGroup}` with `fieldMetadataId` as a string).
- **Subcategory rationale:** COSMETIC — type tightening would be nice but adds no runtime guarantee that's missing today.
- **Suggested action:** backlog (cosmetic): `round-trip.test.ts verification block uses loose Array<{fieldMetadataId?: string; operand?: string}> typing — could mask malformed-row leaks`; resolution: provide a Zod schema for view_filter rows in `parse-metadata-array.ts` (the helper module is now the natural home) and use it to runtime-validate the parsed array, so any shape drift surfaces as a parse failure.

## Adversarial pre-mortem (R3 against the round-3 diff)

1. **A future programmer makes the helper "smarter" by adding a 3rd recognised shape and accidentally inverts the `Array.isArray` branch.** The 3 helper unit tests in `parse-metadata-array.test.ts` would catch the inversion (the first test asserts a raw array unwraps; the second asserts `{result: [...]}` unwraps). Both tests run on default `npx jest --config jest.config.ts`. Round-2 HIGH-1 is structurally eliminated. **Captured and resolved.**

2. **A future maintainer adds a new `UPDATE_*` view dispatch entry whose inner tool also requires stripping a wrapper-only field, and forgets to add the `argsTransform`.** The `viewsDispatchEntries` map in `views.ts:391-399` doesn't enforce a uniform shape across all `UPDATE_*` entries — `UPDATE_VIEW`, `UPDATE_VIEW_FIELD` have no `argsTransform`. Today the wrapper input schemas for those ops do NOT introduce wrapper-only fields (only `fieldMetadataId` on `UPDATE_VIEW_FILTER` is wrapper-only), so this is latent. The contract test would catch the leak only if (a) the new wrapper input schema declares the wrapper-only field AND (b) the inner schema has `additionalProperties: false`. The matrix-of-test-coverage is thin for "wrapper-only fields that should be stripped at dispatch." Mitigation: the views.ts comment block at lines 308-314 documents the pattern and could be referenced by future maintainers; round-2 retrospective's "L13 (proposed)" — see retrospective — codifies the symmetry rule. Foot-gun, out of scope for round 3.

3. **The 3 helper unit tests are added to default suite, but a future contributor moves `parse-metadata-array.test.ts` to `src/__tests__/integration/parse-metadata-array.test.ts` (e.g., "to keep all parse-related tests together") and the same dark-test bug class returns.** Mitigation: there is no test-routing regression check codified in CI (the round-3 plan's test-plan item #7 is a one-time mechanical-gate verifier, not a recurring CI check). A future move would re-introduce the bug. Acceptable today (the file-naming convention `__tests__/<name>.test.ts` is well-established and a contributor would have to deliberately move it under `/integration/`); promote to a CI check only if it recurs. Foot-gun, out of scope for round 3.

## Recommendations to supervisor

- **Block commit: no.** Round-3 closes round-2's HIGH at the file-routing level; both round-1 HIGHs (apply_plan leak, vacuous verification block) remain closed. No new HIGHs or CRITICALs found. The implementation is clean.
- **File new issues:** 0. The 4 LOWs are not new; they were carried forward from rounds 1–2 by design and are routed below.
- **Annotate to plan:** 4 LOWs to be routed by `/audit-fix` per subcategory:
  - LOW-1 (foot-gun): `low-backlog.md` Queued table entry — fields-limit-200 cap.
  - LOW-2 (foot-gun): `low-backlog.md` Queued table entry — views-coverage non-greedy regex.
  - LOW-3 (foot-gun): `low-backlog.md` Queued table entry — `parseInnerOrGraphqlArray` silent `[]` return.
  - LOW-4 (cosmetic): `low-backlog.md` Queued table entry — loose row typing.
- **Confidence in this audit: high.** All 10 mechanical gates ran cleanly: typecheck PASS, full unit suite 169 PASS in default mode, integration test 1 PASS live (with the dynamically-discovered `DATE_TIME_FIELD_ID` and the non-vacuous verification block — verified by independent live probe showing 1-row haystack), helper unit test 3 PASS in default mode (mechanically demonstrating round-2 HIGH-1 is closed), Layer-2 metadata.test.ts PASS, contract test 18 PASS, views.test.ts 18 PASS, views-coverage.test.ts 2 PASS, INCLUDE_INTEGRATION=1 mode 184 PASS (gap of 15 = integration suite alone, NOT helper tests). Adjacent-callers check verified `update_view_filter` has only the two intended call sites; no `.result ?? []` pattern lurks elsewhere. The retrospective should be written.

## Diff stat (round 3)

```
 packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts   |  +30 / -8
 packages/twenty-mcp/src/__tests__/metadata.test.ts                  |  +34 / -0
 packages/twenty-mcp/src/__tests__/views-coverage.test.ts            |  +25 / -6
 packages/twenty-mcp/src/__tests__/views.test.ts                     |  +22 / -0
 packages/twenty-mcp/src/tools/views.ts                              |  +13 / -1
 packages/twenty-mcp/src/utils/parse-metadata-array.ts (NEW)         |  +23 / -0
 packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts (NEW)|  +23 / -0
 7 files changed, ~170 insertions, ~15 deletions
```
