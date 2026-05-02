# Audit report: Fix brittle test infrastructure from issue-3 implementation (#7, #8, #9) — round 1

> Plan: packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness.md
> Round: 1
> Audited: 2026-05-02T21:18:42Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | clean — `_fieldMetadataId` underscore convention compiles. tsconfig excludes `src/**/__tests__/**` (line 20), so test typing leniency is allowed. |
| Lint (`lint:diff-with-main`) | INCONCLUSIVE | Target does not exist for `twenty-mcp` (`Cannot find configuration for task twenty-mcp:lint:diff-with-main`). Direct `npx nx lint twenty-mcp` fails with `Failed to parse config .oxlintrc.json (NotFound)` — but this is **pre-existing** (verified by stashing the diff and re-running the command; same error). twenty-mcp ships no `.oxlintrc.json` at all (every other package does). Running `npx oxlint` directly with default rules on the four changed files yields one **pre-existing** warning: `MOCK_SELECT_FIELD_RESPONSE` declared but never used in `views.test.ts:6` — predates this PR (not introduced by the diff). No new lint defects from this PR. |
| Full unit suite (`npx jest --config jest.config.ts`) | PASS | 13 suites, 165 tests, 18.7s. Matches the implementer's reported numbers. |
| Adjacent-callers check | DEFECTS | `metadataApplyPlan` in `metadata.ts:569-573` dispatches `UPDATE_VIEW_FILTER` via `viewsDispatchEntries` (no `argsTransform`). It forwards `effectiveArgs` (which still carries `fieldMetadataId`) into `wrapInExecute(client, 'update_view_filter', innerArgs)` — same #9 leak class, in the apply_plan path. The fix at `views.ts:368` only protects the direct `metadata_update_view_filter` tool, not apply_plan's `UPDATE_VIEW_FILTER` op. See HIGH-1 below. The plan acknowledged this (supervisor-prompt note) but the implementer chose not to address it; the audit verifies-and-notes per the prompt's explicit guidance. |

Live-stack mechanical gates (also run, all PASS):
- Integration test (`TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- jest --testNamePattern="operand validation"`): PASS — 1 test passes, 9 skipped.
- Contract test: PASS — 18 tests.
- Views unit test: PASS — 18 tests including the two new fieldMetadataId-leak assertions.
- Views-coverage test: PASS — 2 tests; the generic spread resolver correctly resolves both `...emptyOperands` and `...relationOperands` against the live twenty-front source.

Live-stack probes (run via standalone scripts in package dir; cleaned up after):
- `metadata_query({kind: 'fields', args: {limit: 200}})` → returns a raw JSON array of length **exactly 200** (capped). 53 of those are DATE_TIME. So today the test discovers a DATE_TIME field. Foot-gun noted in LOW-2 below.
- `metadata_query({kind: 'view_filters', args: {limit: 200}})` → also returns a raw JSON array (NOT `{result: [...]}`). This contradicts the "independent verification" code path at `round-trip.test.ts:289-300`. See HIGH-2 below.

## Defects found

### CRITICAL — none.

### HIGH — blocks commit

#### HIGH-1: `apply_plan` UPDATE_VIEW_FILTER path leaks `fieldMetadataId` to `update_view_filter` inner tool — same #9 bug class, parallel location

- **What:** The fix at `packages/twenty-mcp/src/tools/views.ts:368` strips `fieldMetadataId` from `args` before forwarding to `update_view_filter`. But `apply_plan` does not go through that handler — it dispatches via `viewsDispatchEntries` (`packages/twenty-mcp/src/tools/views.ts:384`), and the dispatch entry has no `argsTransform`. The dispatcher at `packages/twenty-mcp/src/tools/metadata.ts:569-573` forwards `effectiveArgs` (which still contains `fieldMetadataId`) directly via `wrapInExecute(client, dispatch.innerToolName, innerArgs)`.
- **Why HIGH (not MEDIUM):** The plan's stated rationale for fix #9 is "today Twenty's Zod is in passthrough mode so the extra field is silently dropped, but if Twenty hardens to `.strict()` mode, every UPDATE_VIEW_FILTER call that passes an operand (and therefore requires `fieldMetadataId`) will fail with an opaque `unrecognized key` error." That rationale applies to the apply_plan path identically — and the apply_plan path's `assertOperandCompatible` precondition at `metadata.ts:545-554` *requires* fieldMetadataId for any UPDATE_VIEW_FILTER with operand. Every operand-bearing UPDATE_VIEW_FILTER apply_plan call will leak. The plan claims #9 is fixed; the second of the two call sites is unfixed. R1 violation: the fix is "implemented" for one of two paths but reported as "exercised."
- **Evidence (file:line):**
  - `packages/twenty-mcp/src/tools/views.ts:384` — `UPDATE_VIEW_FILTER: { transport: 'inner_tool', innerToolName: 'update_view_filter' }` — no `argsTransform`.
  - `packages/twenty-mcp/src/tools/metadata.ts:569-573` — generic dispatcher forwards `effectiveArgs` unmodified.
  - `packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json:2324-2327` — `update_view_filter` declares `additionalProperties: false` and only `id, operand, value, subFieldName` as properties.
  - The new contract-test fixture entry for `update_view_filter` has `forbiddenTopLevel: []`, so the contract test does not catch this leak. No call site in `contract.test.ts` exercises `update_view_filter`.
- **Why the supervisor's note matters here:** The supervisor explicitly flagged this concern as "Either is acceptable but the audit should verify and note." The audit verifies the leak is real and severe enough that it warrants HIGH classification — because the plan body claims #9 is resolved and the implementation only covers one of two leak paths, the work fails R1 ("Implemented is not exercised") and creates a Done-because-foreground-checklist-empty risk: a future Twenty schema hardening would surface the bug in the apply_plan path while the developer believes it was already fixed.
- **Suggested fix:**
  - Either add an `argsTransform` to the `UPDATE_VIEW_FILTER` dispatch entry that strips `fieldMetadataId`:
    ```ts
    UPDATE_VIEW_FILTER: {
      transport: 'inner_tool',
      innerToolName: 'update_view_filter',
      argsTransform: (args) => {
        const { fieldMetadataId: _, ...forwardArgs } = args as Record<string, unknown>;
        return forwardArgs;
      },
    },
    ```
  - OR, cleaner: in `metadata.ts` after the operand validation block (line 565), strip `fieldMetadataId` from `effectiveArgs` for UPDATE_VIEW_FILTER before the inner-tool dispatch. Either approach must be accompanied by a test in `views.test.ts` (for argsTransform) or `metadata.test.ts` (for inline strip) asserting that the captured inner-tool call args do NOT contain `fieldMetadataId`.

#### HIGH-2: `round-trip.test.ts` "independent verification" silently no-ops — Tested-because-mock-passes regression

- **What:** The integration test's "independent verification" block at `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:285-300` queries `metadata_query({kind: 'view_filters'})` and parses it as `{ result?: Array<...> }`, then `(viewFiltersParsed.result ?? []).filter(...)`. But `view_filters` (like `fields`) routes through inner_tool transport — verified live: returns a **raw JSON array**, not `{result: [...]}`. So `viewFiltersParsed.result` is `undefined`, `?? []` produces `[]`, and `leakedRows` is always `[]`. The `expect(leakedRows).toEqual([])` assertion trivially passes regardless of whether a leak occurred.
- **Why HIGH:** This is *exactly* the bug class the supervisor's surprise note flagged for the `beforeAll` block. The implementer fixed it for the DATE_TIME-discovery `beforeAll` (lines 238-241, defensive `Array.isArray(raw)` check) but copied the buggy shape forward into the verification step (line 297). The comment immediately above (lines 285-288) explicitly states "Without this step, a future regression that bypasses the wrapper's rejection would still pass the assertions above" — the verification step is precisely the safety-net the comment promises, and it does not perform that verification. R4 violation: the assertion has no mechanical verifier; it's a vibes-check that always passes. R3 violation: the third failure mode the auditor would have named ("the verification block is shape-broken in the same way as `beforeAll` was shape-broken") was not pre-mortemed. This silently restores the Tested-because-mock-passes class that issue #7 itself was supposed to fix.
- **Evidence:**
  - Live probe of `metadata_query({kind: 'view_filters', args: {limit: 200}})` against running stack returns: `[{"id":"bd153456-...","viewId":"...","fieldMetadataId":"...","operand":"IS",...}]` — top-level array, `isArray: true`.
  - `round-trip.test.ts:289-300` parses as `{ result?: ... }` and accesses `.result` → undefined.
  - The integration test "passed" the supervisor's gate because the TYPE OF assertion (`expect([]).toEqual([])`) trivially holds — it is not the assertion the comment promises.
- **Suggested fix:** Apply the same defensive parse used in the `beforeAll`:
  ```ts
  const viewFiltersRaw = JSON.parse(viewFiltersText) as unknown;
  const viewFilterRows: Array<{ fieldMetadataId?: string; operand?: string }> =
    Array.isArray(viewFiltersRaw)
      ? (viewFiltersRaw as Array<{ fieldMetadataId?: string; operand?: string }>)
      : ((viewFiltersRaw as { result?: Array<{ fieldMetadataId?: string; operand?: string }> }).result ?? []);
  const leakedRows = viewFilterRows.filter(
    (row) => row.fieldMetadataId === DATE_TIME_FIELD_ID && row.operand === 'GREATER_THAN_OR_EQUAL',
  );
  expect(leakedRows).toEqual([]);
  ```
  Plus: extract the defensive parse into a small helper at the top of the file (or in `metadata.ts` if it applies cross-tool) so future inner_tool-transport reads cannot make the same mistake. Surprise#5 in the implementer's notes already flagged the GraphQL-vs-inner_tool shape projection as Imagined-because-plausible; HIGH-2 is the same projection at a second site that the surprise note didn't catch.

### MEDIUM — none.

### LOW — varied routing per subcategory

#### LOW-1: `metadata_query({kind: 'fields', args: {limit: 200}})` is at the limit cap on the live workspace [FOOT-GUN] (`round-trip.test.ts:234`)

- **What:** Live probe shows the fields query returns exactly 200 rows — the limit is hit. Today 53/200 are DATE_TIME and the test passes. If a workspace's field ordering ever changes such that DATE_TIME fields are pushed past the 200 cutoff, the test would fail with "no DATE_TIME field found in workspace — reseed with stock data" — but the actual problem is "limit too low," not "stock data missing." Misleading error message.
- **Why low:** Today on the live stack the test works; this is latent. The plan's pre-mortem #2 already explicitly anticipated and accepted this risk.
- **Subcategory rationale:** FOOT-GUN, not TRIVIAL-IN-PLACE — it's latent today (the test passes) and only matters if some other change happens later (workspace grows or field ordering shifts). The plan already accepted the trade-off.
- **Suggested action:** backlog (foot-gun): `round-trip.test.ts beforeAll caps fields query at 200 — could miss DATE_TIME if workspace field count exceeds limit and ordering pushes it past page boundary`; resolution: either page through all field-metadata results in beforeAll, or use `kind: 'objects'` first to find a known stock object (e.g. `company`) and then query its fields directly via `objectMetadataId` filter to get a small focused list.

#### LOW-2: views-coverage.test.ts spread-resolver regex stops at the first `]` [FOOT-GUN] (`views-coverage.test.ts:103-104`)

- **What:** The spread declaration regex `const\\s+${spreadName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]` uses non-greedy `[\\s\\S]*?\\]`, which matches up to the FIRST `]`. Today the spread declarations in twenty-front (`const emptyOperands = [...]`, `const relationOperands = [...]`) contain only flat operand lists — no nested arrays — so this works correctly. If twenty-front ever introduces a nested array inside a spread declaration (e.g. `const fooOperands = [[X, Y], Z]`), the parser would slice off too early and miss operands.
- **Why low:** Today the test passes correctly (verified live against the actual twenty-front file). The risk only surfaces if twenty-front evolves to use nested arrays inside spread-target consts — which is unlikely for a lookup table of operands.
- **Subcategory rationale:** FOOT-GUN, not COSMETIC — there's a real bug class here (silent miss → false-pass), but it requires a specific upstream syntax change to trigger.
- **Suggested action:** backlog (foot-gun): `views-coverage.test.ts spread declaration regex uses non-greedy [\\s\\S]*?\\] — would mis-slice if a spread const contains nested arrays`; resolution: switch to a balanced-bracket scan analogous to the one already used for the FILTER_OPERANDS_MAP block (line 50-58), or migrate to the TypeScript compiler API (`createSourceFile` + AST walk) for true syntactic robustness. The plan's "Out of scope" section already accepted the regex approach and noted TS compiler API as the gold-standard path.

#### LOW-3: `beforeAll` error message is misleading when the failure is shape change rather than missing data [TRIVIAL-IN-PLACE] (`round-trip.test.ts:243-247`)

- **What:** If the upstream API response shape ever changes such that neither `Array.isArray(raw)` nor `raw.result` produces a usable array, the resulting `[]` triggers the throw with message "no DATE_TIME field found in workspace — reseed with stock data before running integration tests." The actual root cause in that scenario would be "API shape changed" (or "API key invalid") not "stock data missing."
- **Why low:** The error fires loud (test fails); only the suggested remediation is misleading. A maintainer following the message would re-seed and the test would still fail, prompting them to dig deeper — recoverable, not silent.
- **Subcategory rationale:** TRIVIAL-IN-PLACE — a one-line edit to make the error message also include the parsed shape: e.g. `'no DATE_TIME field found in workspace (parsed ${Array.isArray(raw) ? \`array of ${fields.length}\` : \`object with keys ${Object.keys(raw as object).join(",")}\`}) — reseed stock data OR investigate response shape drift'`. Cost ≈ 30s.
- **Suggested action:** absorb pre-commit; one-line edit to the throw message in `round-trip.test.ts:244` to include `Array.isArray(raw) ? array length : top-level keys`. Estimated absorb time: 1min.

## Adversarial pre-mortem (R3 against the diff)

1. **A future fix to the apply_plan dispatcher's UPDATE_VIEW_FILTER path lands in the next plan; the maintainer assumes #9 was fully fixed and writes only the dispatcher fix without re-validating the wrapper handler — but the wrapper handler's underscore-prefix destructure was load-bearing for a different reason (e.g. shape consistency with apply_plan), and the second fix breaks it.** Risk: the two paths diverge silently. Captured in HIGH-1's suggested fix: ensure both paths share the same `stripFieldMetadataId` helper exported once.

2. **Twenty's `update_view_filter` inner schema gains a new optional property (e.g. `positionInViewFilterGroup`) and the wrapper's `metadataUpdateViewFilterInputSchema` doesn't add it. The destructure `const { fieldMetadataId: _fieldMetadataId, ...forwardArgs } = args` then forwards everything else correctly — but the views-coverage test catches *only* the FILTER_OPERANDS_MAP drift; nothing in the test suite catches inner-schema property drift between the captured fixture and the wrapper's Zod input schema.** Risk: bug class #5 (Pattern-applied-without-verification) recurs. Mitigation today: contract-test fixtures are refreshed via `capture-inner-schemas.ts`; this is a foot-gun for the existing capture workflow, not introduced by this PR. Out of scope for blocking.

3. **Twenty-front evolves `getRecordFilterOperands.ts` to define `FILTER_OPERANDS_MAP` via a helper function call rather than an object literal (e.g. `export const FILTER_OPERANDS_MAP = buildOperandsMap({...})`).** The parser at `views-coverage.test.ts:43` looks for `export const FILTER_OPERANDS_MAP\s*=\s*\{` and would throw `Could not find FILTER_OPERANDS_MAP in twenty-front source`. Risk: drift gate fires loud (acceptable). But the failure points the maintainer at the parser, not the upstream change. Captured in LOW-2's broader resolution (TS compiler API).

## Recommendations to supervisor

- **Block commit: yes.** HIGH-1 and HIGH-2 are both real defects that re-introduce the bug classes the plan was explicitly written to eliminate. HIGH-1 is the same #9 leak class in a different file; HIGH-2 is the same shape-projection bug class the plan's `beforeAll` correctly fixed at line 238 but re-introduced at line 297. Shipping with these means a future Twenty schema hardening would surface bugs the plan-body claims are fixed (R1 violation).
- **File new issues:** 0. HIGH-1 and HIGH-2 should be folded into a re-implementation of this plan's same scope, not deferred.
- **Annotate to plan:** 3 LOWs (1 trivial-in-place to absorb pre-commit if/when round 2 ships clean; 2 foot-guns for backlog).
- **Confidence in this audit: high.** Live-stack probes confirm both shape concerns; type check passes; full unit suite + integration test suite ran clean. The two HIGHs are both directly traceable to failed adversarial reading: HIGH-1 was hinted at in the supervisor's prompt and verified mechanically; HIGH-2 was revealed by re-applying the plan's own surprise-note logic to the second metadata_query call site in the same file.
