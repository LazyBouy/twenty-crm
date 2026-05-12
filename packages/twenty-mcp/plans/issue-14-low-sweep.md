# Plan: Low-priority audit findings sweep — 10 items (2026-05-02..2026-05-12)

> Issue(s): #14
> Package: packages/twenty-mcp
> Severity: low
> Worst-case bug class if deferred: see per-item notes below
> Created: 2026-05-12

## Problem statement

This plan batches 10 low-priority findings from audit rounds across issues #1, #2, #3, #6, #7, and #11. Each item was classified as either `foot-gun` (latent failure path that degrades gracefully today but will fire loudly on a specific future change) or `cosmetic` (unnecessary noise or inconsistency). None blocks current operation. All 10 are addressed in a single implementation pass to minimise context-switching. The items are ordered so that the three cosmetics (2, 3, 10) land first (lowest blast radius), then the seven foot-guns (1, 4, 5, 6, 7, 8, 9) in ascending blast-radius order.

---

## Items

### Item 1 — `findUnresolved` error-message re-parse foot-gun

**Source**: `issue-1-...-audit-round-1.md` (LOW 2)
**Subcategory**: foot-gun

**Problem**: `findUnresolved` in `packages/twenty-mcp/src/tools/metadata.ts` (or wherever placeholder resolution lives) returns the matched literal placeholder string (e.g. `"$myKey"`). A separate regex downstream strips the dollar/braces to produce the error message. If the placeholder regex is ever widened to support embedded placeholders (e.g. `${prefix.key}`) the error-message regex will mis-slice the string, producing a confusing `"referenced mutation '...embedded prefix.key here...'"` message that doesn't identify the actual missing key.

**Reproduction**: n/a — the bug only surfaces when the placeholder regex format changes. Currently the two regexes are consistent.

**Proposed fix**: Refactor `findUnresolved` to return a structured object `{location: string, key: string}` where `key` is the already-extracted placeholder key (without dollar/braces). The error-message construction uses `result.key` directly without a second parse. The caller at the call site changes from `const placeholder = findUnresolved(...)` + a second regex to `const { key } = findUnresolved(...)`.

Files to modify:
- `packages/twenty-mcp/src/tools/metadata.ts` (or wherever `findUnresolved` is defined) — change return type and internal logic.
- Update all callers of `findUnresolved` to destructure `key` instead of re-parsing.

**Test plan item**:
```bash
cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --config jest.config.ts
```
Expected: all existing tests pass. Add one new test: call the handler with an unresolved placeholder and assert the error message contains the extracted key directly (not a re-parsed form). Verify the test fails before the refactor and passes after.

---

### Item 2 — Redundant `TwentyMcpClient` import in `metadata.test.ts`

**Source**: `issue-2-...-audit-round-1.md` (LOW 3)
**Subcategory**: cosmetic

**Problem**: `packages/twenty-mcp/src/__tests__/metadata.test.ts:6` imports `TwentyMcpClient` explicitly even though the type is already inferred via `makeClient`'s return type. The explicit import is dead code; it adds noise to the import block and will cause a lint error if unused-import rules are ever added.

**Reproduction**: n/a — cosmetic only.

**Proposed fix**: Remove line 6 (`import { TwentyMcpClient } from '../twenty-mcp-client';`) from `metadata.test.ts`. Confirm no other reference to `TwentyMcpClient` remains in the file after removal.

**Test plan item**:
```bash
cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --config jest.config.ts
```
Expected: all tests still pass after import removal. Additionally:
```bash
cd packages/twenty-mcp && npx nx typecheck twenty-mcp
```
Expected: 0 errors — the removed import was genuinely unused.

---

### Item 3 — Prettier drift across 6 changed files

**Source**: `issue-3-...-audit-round-2.md` (L-1)
**Subcategory**: cosmetic

**Problem**: The audit noted ~150+ lines of prettier drift across 6 files changed by the issue-#3 fix: `FIELD_TYPE_OPERAND_MAP` table-style format, `OPERAND_MATRIX_DESCRIPTION` template literal, and new test files. These files have inconsistent indentation/line-wrapping relative to the project's prettier config.

**Reproduction**: n/a — cosmetic only.

**Proposed fix**: Run the linter/formatter on the affected files:
```bash
cd packages/twenty-mcp
npx nx lint twenty-mcp --configuration=fix 2>/dev/null || \
  npx prettier --write \
    src/tools/views.ts \
    src/__tests__/views.test.ts \
    src/__tests__/views-coverage.test.ts \
    src/__tests__/crm.test.ts \
    src/__tests__/crm-coverage.test.ts \
    src/__tests__/contract.test.ts
```
Commit the formatting-only diff. No logic changes.

**Test plan item**:
```bash
cd packages/twenty-mcp && npx jest --config jest.config.ts
```
Expected: all tests still pass after formatting — formatting must not change any logic. Verify the diff is whitespace/line-wrap only by running:
```bash
git diff --stat HEAD
# Expect: only the 6 formatting-target files appear; no other files touched.
```

---

### Item 4 — `views-coverage.test.ts` silently skips on missing `TWENTY_FRONT_SOURCE`

**Source**: `issue-3-...-audit-round-2.md` (L-3)
**Subcategory**: foot-gun

**Problem**: `packages/twenty-mcp/src/__tests__/views-coverage.test.ts:31–34` uses `it.skip(...)` when `TWENTY_FRONT_SOURCE` doesn't exist. If `twenty-front` is renamed or moved, the drift gate silently becomes a no-op — CI stays green but the coverage test is not running. The bug could go undetected for multiple PRs.

**Reproduction**: n/a — the skip fires only when the source file is absent.

**Proposed fix**: Replace the `it.skip(...)` call in `views-coverage.test.ts:31` with:
```typescript
throw new Error(
  'twenty-front source file missing or moved — update TWENTY_FRONT_SOURCE path in ' +
  'views-coverage.test.ts. Expected: ' + TWENTY_FRONT_SOURCE
);
```
This mirrors the pattern already used in `crm-coverage.test.ts` (where `existsSync` throws on missing source). Consistent and loud.

**Test plan item**:
```bash
# Verify the throw fires loud: temporarily rename the source path constant and run:
cd packages/twenty-mcp && \
  TWENTY_FRONT_SOURCE=/nonexistent npx jest src/__tests__/views-coverage.test.ts \
  --config jest.config.ts 2>&1 | grep "missing or moved"
# Expected: the error message appears, test suite fails (not skips).
# Then restore and confirm suite passes:
npx jest src/__tests__/views-coverage.test.ts --config jest.config.ts
# Expected: passes (source file exists).
```

---

### Item 5 — `round-trip.test.ts` fields query capped at 200

**Source**: `issue-7-...-audit-round-3.md` (L-1)
**Subcategory**: foot-gun

**Problem**: `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` `beforeAll` queries field metadata with a hard limit of 200. If the workspace field count exceeds 200 and ordering pushes `DATE_TIME` (or another tested field) past the page boundary, the query silently truncates and the subsequent assertion misleadingly says "array of 200" — implying complete data. The test could fail non-deterministically in a large workspace.

**Reproduction**: n/a — requires a workspace with >200 fields. Not reproducible on the default local stack. Risk is latent.

**Proposed fix**: Replace the single paginated query with a focused `objectMetadataId`-filtered query: first query `kind: 'objects'` to find the `company` object's `id`, then query `kind: 'fields'` with `filter: {objectMetadataId: {eq: companyId}}` to get ONLY company fields — a focused list that will never exceed a few dozen entries. This eliminates the page-boundary risk entirely without requiring multi-page iteration logic.

Files to modify:
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` `beforeAll` section — replace the generic fields query with the two-step focused query.

**Test plan item**:
```bash
cd packages/twenty-mcp
TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
  npx dotenv -e .env.local -- npx jest \
    --testPathPatterns='round-trip.test.ts' \
    --config jest.config.ts
```
Expected: all integration tests pass. Confirm the `beforeAll` no longer logs "array of 200" in the output — the focused query should return a small list (~10–30 fields for `company`).

---

### Item 6 — `views-coverage.test.ts` non-greedy regex for spread declarations

**Source**: `issue-7-...-audit-round-3.md` (L-2)
**Subcategory**: foot-gun

**Problem**: `packages/twenty-mcp/src/__tests__/views-coverage.test.ts` uses a non-greedy `[\s\S]*?\]` regex to slice spread const declarations. This works today because `twenty-front`'s operand lists are flat arrays. If a spread const ever contains a nested array (e.g. a tuple or array-of-arrays), the non-greedy match closes on the first `]` it finds — mid-array — producing a malformed slice that passes silently (the coverage check sees a partial list and emits no error).

**Reproduction**: n/a — requires a twenty-front change that introduces nested arrays in a spread const. Not current.

**Proposed fix**: Replace the non-greedy `[\s\S]*?\]` match with a balanced-bracket scanner: iterate characters, track `[`/`]` depth, and slice at the closing `]` that returns depth to zero. This is ~15 lines of vanilla TypeScript and is immune to nesting depth.

Files to modify:
- `packages/twenty-mcp/src/__tests__/views-coverage.test.ts` — replace the non-greedy regex slice with the balanced-bracket scan function.

**Test plan item**:
```bash
cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts --config jest.config.ts
```
Expected: all tests pass. Add a unit assertion within the coverage test file that tests the balanced-bracket scan function directly with a nested-array input — confirm it returns the full outer array, not a premature slice.

---

### Item 7 — `parseInnerOrGraphqlArray` returns `[]` on unrecognised shapes

**Source**: `issue-7-...-audit-round-3.md` (L-3)
**Subcategory**: foot-gun

**Problem**: `packages/twenty-mcp/src/utils/parse-metadata-array.ts` `parseInnerOrGraphqlArray` returns `[]` for input shapes it doesn't recognise. If a future Twenty API change returns a third envelope shape (e.g. `{data: [...]}`, paginated `{rows: [...], total: 1}`), the function silently produces an empty result — the same "Tested-because-mock-passes" class as round-1 HIGH-2. Callers would see `[]` and either silently no-op or produce wrong downstream behaviour with no error signal.

**Reproduction**: n/a — requires a future Twenty API envelope change. Not current.

**Proposed fix**: Replace the `return []` fallback at the unrecognised-shape branch with:
```typescript
throw new Error(
  `parseInnerOrGraphqlArray: unrecognised response shape — ` +
  `expected raw array or {result: [...]}; got top-level keys: [${Object.keys(input).join(', ')}]. ` +
  `If Twenty has added a new envelope shape, update parseInnerOrGraphqlArray in parse-metadata-array.ts.`
);
```

Files to modify:
- `packages/twenty-mcp/src/utils/parse-metadata-array.ts` — replace the silent `[]` fallback with a loud throw.

**Test plan item**:
```bash
cd packages/twenty-mcp && npx jest src/__tests__/parse-metadata-array.test.ts --config jest.config.ts
```
Expected: all existing tests pass. Add a test: call `parseInnerOrGraphqlArray` with `{data: [1, 2, 3]}` — expect it to throw with a message containing "unrecognised response shape" and the top-level keys. Verify it throws (does NOT return `[]`).

---

### Item 8 — `round-trip.test.ts` loose view-filter row typing

**Source**: `issue-7-...-audit-round-3.md` (L-4)
**Subcategory**: cosmetic (deferred as cosmetic because it requires Zod; see out-of-scope note)

**Problem**: `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` verification block uses `Array<{fieldMetadataId?: string; operand?: string}>` — both fields optional. A regression where Twenty returns rows with malformed `fieldMetadataId` (e.g. a number, or a missing field) would not surface as a parse failure; the test would pass with undefined values, masking the regression.

**Proposed fix**: Add a Zod schema for view-filter rows in `packages/twenty-mcp/src/utils/parse-metadata-array.ts` (or a new `parse-view-filter-row.ts`):
```typescript
const viewFilterRowSchema = z.object({
  fieldMetadataId: z.string().uuid(),
  operand: z.string().min(1),
});
```
Runtime-validate the parsed array in the integration test's verification block using `viewFilterRowSchema.array().parse(rows)`. Any shape drift surfaces as a Zod parse error.

Files to modify:
- `packages/twenty-mcp/src/utils/parse-metadata-array.ts` (or new `parse-view-filter-row.ts`) — add the schema export.
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` — import and apply the schema in the view-filter verification block.

**Test plan item**:
```bash
cd packages/twenty-mcp
TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
  npx dotenv -e .env.local -- npx jest \
    --testPathPatterns='round-trip.test.ts' \
    --testNamePattern='view' \
    --config jest.config.ts
```
Expected: view-related integration tests pass with Zod validation active. Confirm no Zod parse errors on the actual Twenty response (the schema must match the real response shape).

---

### Item 9 — `sdk-boundary.test.ts` only tests `enableMetadata: true`

**Source**: `issue-6-...-audit-round-1.md` (LOW-2)
**Subcategory**: foot-gun

**Problem**: `packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts` only parametrises over `enableMetadata: true`. If a metadata tool is accidentally moved into the always-on path in `server.ts` (wrong side of the `if (enableMetadata)` branch), the `false` case would be missing from the registry but the test would still pass — because it doesn't exercise the `false` case at all.

**Proposed fix**: Parametrise the `describe` block to run twice — once with `enableMetadata: true` and once with `enableMetadata: false`. For the `false` case, assert the registered tool set equals the seven baseline families: `{discovery, search_records, get_record, create_record, update_record, delete_record, link_note_to_record}`. This is a hard contract that catches any accidental migration across the feature flag boundary.

Files to modify:
- `packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts` — add a second parametrised `describe` block for `enableMetadata: false`.

**Test plan item**:
```bash
cd packages/twenty-mcp && npx jest src/__tests__/sdk-boundary.test.ts --config jest.config.ts
```
Expected: both parametrised blocks pass. The `false` case asserts exactly 7 tools are registered (the seven listed above — no more, no fewer). Confirm the test would FAIL if `enableMetadata: false` accidentally registered a metadata tool by temporarily moving a `metadataToolDefinitions` registration outside the `if (enableMetadata)` guard.

---

### Item 10 — `*-coverage.test.ts` pattern inconsistency (throw vs `it.skip`)

**Source**: `issue-11-...-audit-round-1.md` (LOW-3)
**Subcategory**: cosmetic

**Problem**: `crm-coverage.test.ts:21–26` throws on missing source file (loud alarm). `views-coverage.test.ts:31` uses `it.skip` on missing source (silent pass). The inconsistency means a future author adding a new `*-coverage.test.ts` has no consistent pattern to follow — one or the other approach will be copied arbitrarily.

**Note**: Item 4 in this sweep already proposes changing `views-coverage.test.ts` to throw. If item 4 is implemented first, item 10 becomes a no-op (the inconsistency is resolved by item 4). Items 4 and 10 MUST be implemented as a single commit or the implementer must verify item 4 is already done before touching item 10.

**Proposed fix**: Confirm `views-coverage.test.ts` now throws (item 4 fix applied). If a third `*-coverage.test.ts` file exists, ensure it also uses the throw pattern. Add a one-line comment above the throw in each file: `// Loud alarm: if source file moved/renamed, CI fails immediately (not silently skipped).`

**Test plan item**:
```bash
cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts \
  src/__tests__/crm-coverage.test.ts --config jest.config.ts
```
Expected: both pass. Confirm both use throw (not `it.skip`) by running:
```bash
grep -n "it.skip\|it\.skip" packages/twenty-mcp/src/__tests__/*-coverage.test.ts
# Expected: empty output (no `it.skip` in any coverage test file).
```

---

## Failure modes named (R3: combined adversarial pre-mortem)

1. **Implementer processes items in dependency-violating order, causing rework**: item 10 depends on item 4 (if item 4 isn't done first, the `views-coverage.test.ts` `it.skip` still exists and item 10's "confirm both throw" assertion fails). Similarly, item 3 (prettier) changes whitespace in files that items 4, 6, and 10 also touch — running prettier AFTER editing those files avoids a conflict; running it BEFORE produces a clean formatting baseline. Mitigation: process items in the order listed in this plan (2, 3, 10 cosmetics first; then foot-guns 1, 4, 5, 6, 7, 8, 9); enforce via the implementer reading this order note before starting.

2. **One cosmetic fix triggers a lint regression that masks a different cosmetic**: item 3 (prettier) rewrites formatting across 6 files. If those files have a latent lint issue (e.g. an unused import introduced by a prior fix), the lint run after item 3 will surface it — but if the implementer doesn't run lint separately, the issue will be committed in the same formatting-only diff. The next CI run will fail on the lint issue, not on formatting, confusing the reader. Mitigation: run `npx nx typecheck twenty-mcp` AFTER item 3 and BEFORE committing it; any type/lint issues surfaced must be fixed in the same commit.

3. **Sweep items rot after partial implementation**: if the implementer addresses items 1–5 but is interrupted before items 6–10, the plan is partially done. A future reader of the state file sees `status: implementing` but the plan has unaddressed foot-guns. The sweep issue (#14) cannot be closed until ALL 10 items are done. Mitigation: the implementer must commit all 10 items as a single atomic change (one commit per logical group: cosmetics, foot-guns-low, foot-guns-high), or explicitly note in the implementation log which items are deferred and file a follow-up for the remainder before marking this issue as awaiting-commit. "Partially done" is NOT done (R1).

## Out of scope

- **Item 8 (Zod runtime validation for view-filter rows)**: this is listed as cosmetic, but requires adding a Zod schema and a new validation call in the integration test. If the implementer judges the scope too large for a single sweep pass, item 8 may be deferred to a follow-up medium issue. Worst-case bug class if deferred: a Twenty API envelope change silently zeroes out the view-filter verification block (Tested-because-mock-passes class — same as round-1 HIGH-2). Risk: low (envelope changes are rare). Acceptable to defer if the sweep is already large; must be explicitly noted in the implementation log with a filed follow-up issue number.

- **Multi-page field-metadata pagination (Item 5 alternative)**: the proposed fix for item 5 uses an `objectMetadataId`-filtered query instead of pagination. Implementing full pagination (iterate until `hasNextPage: false`) is also correct but significantly more complex. The filtered-query approach is preferred as it eliminates the class of bug entirely rather than raising the page limit. Full pagination is out of scope.

- **TypeScript compiler API migration for `views-coverage.test.ts` spread scanning (Item 6 alternative)**: the `ts-morph` / TypeScript compiler API approach is the most robust solution for parsing TypeScript spread arrays, but adds a dev dependency and significant complexity. The balanced-bracket scanner achieves correctness for the current `twenty-front` patterns without the dependency cost. Compiler API migration is out of scope; worst case if the balanced-bracket scanner fails: a nested-array spread const would be mis-sliced silently — but `twenty-front` currently has no nested spread operand arrays, and the scanner would be no worse than the current non-greedy regex in that case.

## References

- `packages/twenty-mcp/plans/low-backlog.md` — source of all 10 items (now in Swept table)
- `packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution-audit-round-1.md` — item 1 source (LOW 2)
- `packages/twenty-mcp/plans/issue-2-apply-plan-sha256-canonicalization-opaque-audit-round-1.md` — item 2 source (LOW 3)
- `packages/twenty-mcp/plans/issue-3-apply-plan-operand-field-type-validation-audit-round-2.md` — items 3, 4 source (L-1, L-3)
- `packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness-audit-round-3.md` — items 5, 6, 7, 8 source (L-1 through L-4)
- `packages/twenty-mcp/plans/issue-6-sdk-tools-list-boundary-test-audit-round-1.md` — item 9 source (LOW-2)
- `packages/twenty-mcp/plans/issue-11-inner-tool-name-camelcase-boundary-audit-round-1.md` — item 10 source (LOW-3)
- `packages/twenty-mcp/src/__tests__/views-coverage.test.ts:31` — item 4 / item 10 target
- `packages/twenty-mcp/src/__tests__/crm-coverage.test.ts:21–26` — item 10 reference (throw pattern)
- `packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts` — item 9 target
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` — items 5, 8 target
- `packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts` — item 7 target
- `packages/twenty-mcp/src/__tests__/metadata.test.ts` — item 2 target

## Implementation notes
> Implemented: 2026-05-12T00:00:00Z

### Files changed (this plan's edits only)
```
packages/twenty-mcp/src/tools/metadata.ts
packages/twenty-mcp/src/__tests__/metadata.test.ts
packages/twenty-mcp/src/__tests__/views-coverage.test.ts
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts
packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts
packages/twenty-mcp/src/utils/parse-metadata-array.ts
packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts
```
(The full `git diff --name-only` includes additional files from the in-flight #12+#13 diff that were not modified by this plan.)

### Diff stat (plan files only)
Changes include all 9 implemented items plus prettier reformatting across the 6 files from item 3's scope, plus the additional files modified by this plan.

### Test results

**Item 1 (findUnresolved structured return) — PASS**
```
PASS src/__tests__/metadata.test.ts
Tests: 54 passed, 54 total
```
New test: "unresolved placeholder error message contains the extracted key directly (not a re-parsed form)" — passes.

**Item 2 (redundant TwentyMcpClient import) — PASS**
Changed `import { TwentyMcpClient }` to `import type { TwentyMcpClient }` — type-only import prevents runtime emission and satisfies unused-import rules. All 54 metadata tests still pass. typecheck: 0 errors.

**Item 3 (prettier drift) — PASS**
```
npx prettier --write src/tools/views.ts src/__tests__/views.test.ts src/__tests__/views-coverage.test.ts src/__tests__/crm.test.ts src/__tests__/crm-coverage.test.ts src/__tests__/contract.test.ts
npx jest --config jest.config.ts  → 218 passed, 218 total
```

**Item 4 (views-coverage it.skip → throw) — PASS**
```
PASS src/__tests__/views-coverage.test.ts
Tests: 3 passed, 3 total
```
The `it.skip(...)` at line 31-33 replaced with `throw new Error(...)` with loud-alarm comment. Verified the throw code is present at lines 40-44.

**Item 5 (round-trip focused object-filtered query) — PASS (live integration)**
```
PASS src/__tests__/integration/round-trip.test.ts (9.846 s)
Tests: 27 passed, 27 total
```
The operand validation beforeAll now performs two queries: first fetches the 'company' object id, then fetches only company fields (objectMetadataId-filtered). No "array of 200" in output — focused query returns a small list.

**Item 6 (views-coverage balanced-bracket spread scan) — PASS**
```
PASS src/__tests__/views-coverage.test.ts
✓ balanced-bracket scanner correctly slices nested-array spread declarations (item 6 regression guard)
```
Spread declaration parsing now uses balanced-bracket scan (not non-greedy `[\s\S]*?\]`). Unit assertion confirms nested-array input returns all three operands, not just the first.

**Item 7 (parseInnerOrGraphqlArray throws on unrecognised shape) — PASS**
```
PASS src/__tests__/parse-metadata-array.test.ts
Tests: 4 passed, 4 total
✓ throws on unrecognised shapes (item 7: loud failure over silent empty)
✓ throws with the top-level keys in the error message (shape debugging aid)
```

**Item 8 (Zod runtime validation for view-filter rows) — DEFERRED**
Per the plan's "Out of scope" clause. Risk if deferred: a future Twenty API envelope change silently zeroes out the view-filter verification block (Tested-because-mock-passes class). Deferred to a follow-up issue (file as #15 or next available backlog item). The other 9 items are complete.

**Item 9 (sdk-boundary parametrised over both enableMetadata values) — PASS**
```
PASS src/__tests__/sdk-boundary.test.ts
Tests: 5 passed, 5 total
✓ exactly the 7 baseline tools are registered (no metadata tool leaked into default registry)
✓ all 7 baseline tools are present (none accidentally removed)
✓ total registered count is exactly 7
```

**Item 10 (coverage test pattern inconsistency) — MOOT (as predicted)**
`crm-coverage.test.ts` was completely rewritten by the #12+#13 in-flight diff. It is now a resolution-logic test with no throw-on-missing-source pattern. The inconsistency described in item 10 no longer applies to crm-coverage.test.ts. Item 4 resolved the views-coverage.test.ts side. The loud-alarm comment was added to the throw in views-coverage.test.ts as item 10 directed. grep confirms no `it.skip` in any `*-coverage.test.ts` file.

**Full suite — PASS**
```
npx jest --config jest.config.ts → 218 passed, 218 total, 16 suites
npx nx typecheck twenty-mcp → 0 errors
```

### Surprises

1. **Item 2 premise partially wrong**: The plan said to "remove line 6" and "confirm no other reference to TwentyMcpClient remains." However, `TwentyMcpClient` is used as a type in many `as unknown as TwentyMcpClient` casts throughout the file. Full removal would break the file. Changed to `import type { TwentyMcpClient }` instead — this achieves the same goal (no runtime import, lint-safe) without breaking the casts.

2. **Item 4 test command non-functional**: The plan's test command for item 4 uses `TWENTY_FRONT_SOURCE=/nonexistent npx jest` to verify the throw fires. However, the test file computes `TWENTY_FRONT_SOURCE` via `join(__dirname, ...)` at module evaluation time — it does not read `process.env.TWENTY_FRONT_SOURCE`. The env var has no effect. The throw IS correctly implemented and will fire if the actual file at the computed path is absent; the plan's verification command just happens to not work as written.

3. **Item 6 partial fix**: The main `FILTER_OPERANDS_MAP` block parsing already used balanced-bracket scanning before this plan. The remaining non-greedy regex was in the spread declaration lookup (`const\\s+${spreadName}...\\[([\\s\\S]*?)\\]`). Item 6's fix was applied to that inner regex — replacing it with a header-match + balanced-bracket scan.

4. **prettier also reformatted metadata.ts**: The import `import type { ToolsCallResult, TwentyMcpClient }` was already in metadata.ts before item 2's change (it was importing as `import type` from the production source). Prettier reformatted this file as well as the 6 plan-specified files.

5. **No surprises on item 7 callers**: All callers of `parseInnerOrGraphqlArray` in the codebase pass either raw arrays or `{result: [...]}` shapes from Twenty's API — none would be affected by the throw on unrecognised shapes in normal operation.

> Audit round 1: clean-with-mediums (after auditor-incident recovery — see audit-round-1 INCIDENT NOTICE) — see issue-14-low-sweep-audit-round-1.md
> Audit round 1: medium defects → filed issues #16 (white-box duplicate test), #17 (Zod row schema follow-up)
> Audit round 1: LOW absorbed pre-commit (trivial-in-place): parseInnerOrGraphqlArray throw message now uses describe() helper for null/array/object/primitive variants
> Audit round 1: LOW filed as #18 (cross-cutting): twenty-mcp lint:diff-with-main project.json target missing
> Audit round 1: LOW backlogged (foot-gun): crm.ts candidates[0] non-null access without explicit guard
> Audit round 1: LOW backlogged (cosmetic): plan item 4 verification command is misleading (env var not read at module load)
> Audit round 1: LOW backlogged (foot-gun): parseInnerOrGraphqlArray test gap for null input

> RECOVERY NOTE: this audit round caused a CRITICAL procedural incident — the auditor ran `prettier --write` on crm.ts followed by `git checkout --`, discarding the in-flight #12+#13 working-tree changes (resolveObjectNames/buildToolName/camelToSnakeCase refactor). The supervisor recovered the lost source by extracting the original TypeScript from the jest transform cache's sourcemap at /tmp/jest_0/.../crm_*.map (the `sourcesContent[0]` field). After recovery, full unit suite (218/218) and live integration suite (27/27) both pass, confirming the recovery is complete. The auditor's pre-incident findings (this audit's MEDIUMs and LOWs) remain valid and have been routed normally.

> Audit round 2: clean — see issue-14-low-sweep-audit-round-2.md (post-incident recovery confirmed; all round-1 findings routed correctly)
