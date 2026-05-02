# Audit report: Fix brittle test infrastructure from issue-3 implementation (#7, #8, #9) — round 2

> Plan: packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness.md
> Round: 2
> Audited: 2026-05-02T22:30:00Z
> Auditor: issue-auditor (opus)

## Summary up front

Round 2 closes BOTH round-1 HIGHs at the wire level: HIGH-1 (`apply_plan` UPDATE_VIEW_FILTER leak) is closed by the shared `stripFieldMetadataIdFromUpdateArgs` helper used at the direct handler AND on the `UPDATE_VIEW_FILTER` dispatch entry as `argsTransform`; the Layer-2 test in `metadata.test.ts:822-852` asserts on the OUTGOING args (the `arguments` field of the captured `client.toolsCall('execute_tool', …)` call), which is the correct assertion. HIGH-2 (verification block silently no-ops) is closed for the integration path by the `parseInnerOrGraphqlArray` helper at `round-trip.test.ts:69-76`, used in BOTH the `beforeAll` and the verification block; live probe confirms the helper unwraps a real 1-row array (verification is non-vacuous: `viewFilterRows.length === 1`, all rows have `operand === 'IS'`, the `expect(leakedRows).toEqual([])` filter returns `[]` from a non-empty haystack).

However, **a new HIGH defect is introduced**: the standalone `parseInnerOrGraphqlArray — unit` describe block (lines 334-353) lives inside `src/__tests__/integration/round-trip.test.ts`, which is excluded from the default jest run by `testPathIgnorePatterns: /integration/` (`jest.config.ts:12`). The default `npx jest --config jest.config.ts` (and `nx run twenty-mcp:test` per `project.json:39`) does NOT execute these tests — verified mechanically: `npx jest src/__tests__/integration/round-trip.test.ts --testNamePattern='parseInnerOrGraphqlArray'` returns `No tests found … testPathIgnorePatterns: /integration/`. The plan's own test plan item #6 explicitly states the helper unit test "always runs (does NOT depend on `TWENTY_MCP_INTEGRATION=1` etc.)" — that promise is broken at the file-routing level, not the runtime gate. This is the same bug class HIGH-2 was filed to eliminate, just one layer up: the helper exists, and a test for it exists, but the helper test does not actually execute on every full unit-suite run, so a future drift in the helper would silently restore the no-op verification.

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | Clean. `_` underscore destructure compiles fine; tests dir excluded from typecheck. |
| Lint (`lint:diff-with-main`) | INCONCLUSIVE | Same pre-existing tooling gap as round 1: target does not exist for `twenty-mcp`; direct `npx nx lint twenty-mcp` fails with `Failed to parse config .oxlintrc.json (NotFound)` — pre-existing, not introduced by this PR. Direct `npx oxlint` on the four changed files yields ONE warning: `MOCK_SELECT_FIELD_RESPONSE` declared but never used in `views.test.ts:6` — same pre-existing warning flagged in audit-round-1; not introduced by this PR. No new lint defects. |
| Full unit suite (`npx jest --config jest.config.ts`) | PASS | 13 suites, 166 tests, 11.1s. Matches round-2 implementer notes (1 more than round 1 — the new Layer-2 test). |
| Adjacent-callers check | OK | Verified: `metadata.ts:569-573` invokes `dispatch.argsTransform(effectiveArgs)` then forwards `innerArgs` via `wrapInExecute`. `viewsDispatchEntries.UPDATE_VIEW_FILTER` (`views.ts:396-400`) declares `argsTransform: stripFieldMetadataIdFromUpdateArgs`. Direct handler at `views.ts:381` calls `wrapInExecute(client, 'update_view_filter', stripFieldMetadataIdFromUpdateArgs(args))`. Both paths call the same exported function — symmetric Layer-1+Layer-2 fix as the plan promised. |

Live-stack mechanical gates (also run, all PASS at the gate level):
- Integration test (`TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 jest --testNamePattern="operand validation"`): PASS — 1 test, 12 skipped, 1.5s.
- `parseInnerOrGraphqlArray` unit test set (when reachable via `INCLUDE_INTEGRATION=1`): PASS — 3 tests.
- Contract test: PASS — 18 tests.
- Views unit test: PASS — 18 tests including the two new fieldMetadataId-leak assertions.
- Views-coverage test: PASS — 2 tests; generic spread resolver still resolves both `...emptyOperands` and `...relationOperands` correctly.

Live-stack probes (standalone scripts via `lib/twenty-mcp-client.js`, cleaned up):
- `metadata_query({kind: 'fields', args: {limit: 200}})` → returns raw JSON array, length **exactly 200** (capped); 53 DATE_TIME fields. Beforehook discovers a DATE_TIME field today. Foot-gun unchanged from round-1 LOW-1.
- `metadata_query({kind: 'view_filters', args: {limit: 200}})` → returns raw JSON array, length **1** (top-level `Array.isArray === true`). Helper correctly unwraps to a 1-row array. The single row has `operand: "IS"` (NOT `GREATER_THAN_OR_EQUAL`), so `leakedRows` filter returns `[]` from a non-empty haystack — **the `expect(leakedRows).toEqual([])` assertion is genuinely verifying, not vacuous.** Supervisor's clause (d) verified affirmatively.

## Defects found

### CRITICAL — none.

### HIGH — blocks commit

#### HIGH-1: `parseInnerOrGraphqlArray` unit test does NOT run on default unit-suite invocations — same bug class as round-1 HIGH-2, one layer up

- **What:** The new `parseInnerOrGraphqlArray — unit` describe block (`round-trip.test.ts:334-353`) is intended (per the plan's test plan item #6) to be a "non-`describeIfDestructive` block, i.e. always runs" — a mechanical verifier for the helper's correctness so a future change can't silently break the verification block. But the file `round-trip.test.ts` lives under `src/__tests__/integration/`, and `jest.config.ts:12` ignores `/integration/` by default (`testPathIgnorePatterns: process.env.INCLUDE_INTEGRATION === '1' ? [] : ['/integration/']`). Without `INCLUDE_INTEGRATION=1`, the entire file is skipped, including the standalone helper unit tests.
- **Why HIGH (not MEDIUM):**
  - The plan explicitly promises the helper test "actually runs by default" (round-2 plan body, test plan item #6). That promise is mechanically false. R4 violation: an assertion in the PR description has no mechanical verifier in the default test run.
  - This is the same bug class round-1 HIGH-2 was filed to fix: a test that LOOKS like it's verifying but isn't actually executing the verification path. Round 1 caught it at the assertion level (`{result?: ...}.result ?? []` always `[]`); round 2 introduces a structurally-equivalent regression at the file-routing level (test exists, test even runs locally if you happen to set `INCLUDE_INTEGRATION=1`, but the default workflow skips it).
  - Concrete consequence: the project's `nx run twenty-mcp:test` target (`project.json:38-43`) runs `NODE_ENV=test jest --testTimeout 10000` — no `INCLUDE_INTEGRATION=1`. CI invocations through that target will never execute the helper unit tests. A future regression that breaks `parseInnerOrGraphqlArray` (e.g., a refactor that accidentally inverts the array check, or someone "simplifying" by removing the `Array.isArray` branch) would silently restore the verification-block-no-op without any failing test.
  - Per `twenty-mcp/CLAUDE.md`'s before-shipping checklist, `npx jest --testTimeout 10000` (full unit suite) green is a mechanical gate. The helper test is not part of that gate today.
- **Evidence:**
  - `packages/twenty-mcp/jest.config.ts:12` — `testPathIgnorePatterns: process.env.INCLUDE_INTEGRATION === '1' ? [] : ['/integration/']`.
  - `packages/twenty-mcp/project.json:38-43` — test target invocation has no `INCLUDE_INTEGRATION=1`.
  - Mechanical reproducer (run from `packages/twenty-mcp`): `npx jest src/__tests__/integration/round-trip.test.ts --testNamePattern='parseInnerOrGraphqlArray' --config jest.config.ts` → `No tests found, exiting with code 1` + `testPathIgnorePatterns: /integration/`.
  - Contrast: `INCLUDE_INTEGRATION=1 npx jest --config jest.config.ts` runs 169 tests (166 + the 3 helper unit tests); default `npx jest --config jest.config.ts` runs 166 tests. Delta is exactly the helper unit tests.
  - File line range that is dark on the default test path: `round-trip.test.ts:334-353` (the entire `describe('parseInnerOrGraphqlArray — unit', …)` block).
- **Suggested fix (one of):**
  - **Option A (preferred — minimal change to the file structure):** Move the helper out of `round-trip.test.ts` into a sibling unit-test-friendly location, e.g. extract `parseInnerOrGraphqlArray` to `src/tools/metadata-shape.ts` (or a small `src/utils/parse-metadata-array.ts`) and create `src/__tests__/parse-metadata-array.test.ts` with the same three assertions. The integration test imports from the new module. The helper-correctness test now runs in the default unit suite.
  - **Option B (lower-cost, less ideal):** Update the project's `test` target in `project.json` to set `INCLUDE_INTEGRATION=1` for the full-unit-suite run (and update `jest.config.ts` to keep its current `testPathIgnorePatterns` logic as fallback for users who explicitly want to skip integration compilation time). Risk: this changes the meaning of the env flag — `INCLUDE_INTEGRATION=1` becomes "always on for unit suite" which conflates with the integration-suite gate the file uses. Option A keeps the abstractions cleaner.
  - Either option must be accompanied by a mechanical verifier: after the change, `npx jest --config jest.config.ts` (no env flags) must include the three helper assertions in its test count.

### MEDIUM — none.

### LOW — varied routing per subcategory

#### LOW-1 (carried forward from round 1): `metadata_query({kind: 'fields', args: {limit: 200}})` is at the limit cap on the live workspace [FOOT-GUN] (`round-trip.test.ts:252`)

- **What:** Live probe (re-run for round 2) shows the fields query still returns exactly 200 rows on the local stock workspace. 53/200 are DATE_TIME and the test discovers one. If a workspace's field ordering ever changes such that DATE_TIME fields are pushed past the 200 cutoff, the test would fail with the round-2 improved error message ("no DATE_TIME field found in workspace (parsed: array of 200) — Either reseed stock data, OR investigate response-shape drift") — which is now unambiguous between the two failure modes (round-2 LOW-3 absorption helps here), but the actual problem in this scenario is "limit too low," neither of those.
- **Why low:** Today on the live stack the test works; this is latent. Round-2 LOW-3 absorption improved the error message but did not change the underlying limit cap.
- **Subcategory rationale:** FOOT-GUN — latent today, requires upstream change (workspace growth or field-ordering shift) to surface.
- **Suggested action:** backlog (foot-gun): `round-trip.test.ts beforeAll caps fields query at 200 — could miss DATE_TIME if workspace field count exceeds limit and ordering pushes it past page boundary, AND the error message will misleadingly say "array of 200" implying complete data`; resolution: page through all field-metadata results in beforeAll, OR query `kind: 'objects'` first to find a known stock object (e.g. `company`) and then query its fields directly via `objectMetadataId` filter to get a small focused list.

#### LOW-2 (carried forward from round 1): views-coverage.test.ts spread-resolver regex stops at the first `]` [FOOT-GUN] (`views-coverage.test.ts:103-104`)

- **What:** Unchanged from round 1. The spread declaration regex `const\\s+${spreadName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]` uses non-greedy `[\\s\\S]*?\\]`, which matches up to the FIRST `]`. Today the spread declarations in twenty-front contain only flat operand lists, so this works. If twenty-front ever introduces a nested array inside a spread declaration, the parser would slice off too early and miss operands.
- **Why low:** Today the test passes correctly. Risk only surfaces if twenty-front evolves to use nested arrays inside spread-target consts — unlikely for a lookup table of operands.
- **Subcategory rationale:** FOOT-GUN — real bug class (silent miss → false-pass) but requires specific upstream syntax change.
- **Suggested action:** backlog (foot-gun): `views-coverage.test.ts spread declaration regex uses non-greedy [\\s\\S]*?\\] — would mis-slice if a spread const contains nested arrays`; resolution: switch to a balanced-bracket scan analogous to the FILTER_OPERANDS_MAP block scan (lines 50-58), or migrate to TypeScript compiler API.

#### LOW-3: `parseInnerOrGraphqlArray` returns `[]` silently for unrecognised shapes [FOOT-GUN] (`round-trip.test.ts:69-76`)

- **What:** When the input JSON is neither a top-level array nor `{result: [...]}`, `parseInnerOrGraphqlArray` returns `[]`. This is documented by the unit test at line 349-352 ("object without result key returns []"). For the verification block (`round-trip.test.ts:312-325`), this means: if a future Twenty API change returns view_filters wrapped in a different envelope (e.g. `{data: [...]}`, or `{viewFilters: [...]}`, or paginated `{rows: [...], total: 1}`), the helper silently returns `[]` and the assertion `expect(leakedRows).toEqual([])` is vacuously true again — exact same Tested-because-mock-passes class as round-1 HIGH-2.
- **Why low:** Today, both `view_filters` (inner_tool) and the wrapped GraphQL kinds are accounted for; this is latent. The plan's "Out of scope" doesn't anticipate a third envelope shape.
- **Subcategory rationale:** FOOT-GUN — only matters if an upstream Twenty change introduces a third shape. Promote to MEDIUM if Twenty's transport layer is known to be in flux.
- **Suggested action:** backlog (foot-gun): `parseInnerOrGraphqlArray returns [] for unrecognised shapes — would silently no-op the verification block again if a future Twenty API change returns a third envelope shape`; resolution: throw on unrecognised shape (`throw new Error('parseInnerOrGraphqlArray: input is neither raw array nor {result: [...]}; got top-level keys [' + Object.keys(raw).join(', ') + ']')`) so a shape drift fires a loud failure rather than a silent no-op. Risk of throwing: the helper currently lives in a test file and an unrecognised shape would crash the whole test instead of a clean assertion failure — but that's preferable to silent vacuity, which is precisely the bug class issue #7 was filed to eliminate.

#### LOW-4: `viewFilterRows` typing is loose enough that a future regression could land in a malformed row without surfacing [COSMETIC] (`round-trip.test.ts:317-320`)

- **What:** The verification block types `viewFilterRows` as `Array<{ fieldMetadataId?: string; operand?: string }>` — both fields are optional. If a future regression caused Twenty to return rows with the leaked `fieldMetadataId` but a malformed shape (e.g. `fieldMetadataId` is a number, or absent), the optional-string type means `row.fieldMetadataId === DATE_TIME_FIELD_ID` would still be a valid expression and would just evaluate to `false`. The leakedRows filter would still produce `[]` even if there were leaks of a different shape.
- **Why low:** Twenty's view_filters response is well-defined; this is purely defensive typing, not a real risk vector today.
- **Subcategory rationale:** COSMETIC — type tightening would be nice but adds no runtime guarantee that's missing today.
- **Suggested action:** backlog (cosmetic): `round-trip.test.ts verification block uses loose Array<{fieldMetadataId?: string; operand?: string}> typing — could mask malformed-row leaks`; resolution: if `parseInnerOrGraphqlArray<T>` is migrated out (per HIGH-1 fix Option A), provide a Zod schema for view_filter rows and use it to runtime-validate the parsed array, so any shape drift surfaces as a parse failure.

## Adversarial pre-mortem (R3 against the round-2 diff)

1. **A future change to `parseInnerOrGraphqlArray` (e.g., refactor for a third transport shape) inverts the `Array.isArray(raw)` branch.** The integration test still passes (the helper unit tests don't run on default unit suite per HIGH-1). The verification block now silently returns `[]` for the inner_tool shape — round-1 HIGH-2 fully restored. The helper unit test that would catch this drift is dark unless someone explicitly sets `INCLUDE_INTEGRATION=1`. **Captured as HIGH-1.**

2. **Twenty's `update_view_filter` inner schema gains a new optional property (e.g., `positionInViewFilterGroup` is already returned in the live probe — see view_filter row structure). The current strip helper only removes `fieldMetadataId`; if the wrapper's `metadataUpdateViewFilterInputSchema` ever adds another wrapper-only property (e.g., a precomputed `fieldType` to skip the lookup), it would also leak.** Mitigation today: only `fieldMetadataId` is wrapper-only; nothing in this PR adds another. Risk surface is bounded by the input schema (`metadataUpdateViewFilterInputSchema`, `views.ts:299-313`). Acceptable foot-gun, captured implicitly by the contract test which would fail if a leak propagated to the captured fixture's `additionalProperties: false`.

3. **A maintainer adds a new `UPDATE_*` view op (e.g., UPDATE_VIEW_SORT) whose inner tool also doesn't accept `fieldMetadataId`, and forgets to add `argsTransform` to the new dispatch entry.** The `viewsDispatchEntries` map in `views.ts:390-402` doesn't enforce a uniform shape across all `UPDATE_*` entries. The round-2 fix is correct for `UPDATE_VIEW_FILTER` specifically but doesn't generalise. Mitigation: the contract test would catch the leak only if the wrapper input schema for that new op also declares `fieldMetadataId` (so `additionalProperties: false` on the inner schema would reject) AND there's a fixture entry for the new inner tool. The matrix-of-test-coverage is thin for "wrapper-only fields that should be stripped at dispatch." Captured as a follow-up consideration; not blocking, since today the only such field is `fieldMetadataId` on `UPDATE_VIEW_FILTER`.

## Recommendations to supervisor

- **Block commit: yes.** HIGH-1 (the parseInnerOrGraphqlArray unit test does NOT run on default unit suite) re-introduces the same Tested-because-mock-passes class one layer up: the helper-correctness test exists, but the default test workflow doesn't execute it, so a future regression in the helper would silently pass CI. The plan's own test plan item #6 explicitly promises this test "always runs" and that promise is mechanically false. Per R4 (every assertion has a mechanical verifier in the default suite), this is a structural failure.
- **File new issues:** 0. HIGH-1 should be folded into a round-3 re-implementation of this plan (move helper out, or change test target's env), not deferred.
- **Annotate to plan:** 4 LOWs (2 carried forward as foot-guns, 1 new foot-gun on `parseInnerOrGraphqlArray`'s silent `[]` return for unknown shapes, 1 new cosmetic typing tightening). The trivial-in-place LOW-3 from round 1 was absorbed correctly in round 2.
- **Confidence in this audit: high.** Live-stack probes confirmed the verification block is non-vacuous (1-row haystack); type check, all 13 unit suites, integration test, and contract test pass; the Layer-2 metadata.test.ts assertion is correctly on outgoing args (not incoming); `metadata.ts:569-573` does invoke `argsTransform`. The single HIGH was found by mechanically running the parseInnerOrGraphqlArray test by name with default config and observing `No tests found … testPathIgnorePatterns: /integration/`.
