# Plan: Zod runtime validation for view-filter rows in round-trip.test.ts

> Issue(s): #17
> Package: packages/twenty-mcp
> Severity: medium
> Worst-case bug class if deferred: Tested-because-mock-passes — a Twenty API envelope change that alters the shape of `view_filters` response rows silently zeroes out the verification block in `round-trip.test.ts` (the `leakedRows` filter would pass vacuously if `fieldMetadataId` is renamed upstream), reproducing the exact bug class issue #7 (HIGH-2) was filed to eliminate
> Created: 2026-05-12

## Problem statement

`packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:360–369` fetches view-filter rows from Twenty and filters them using `row.fieldMetadataId` and `row.operand`. Both properties are typed as `string | undefined` via the inline generic `{fieldMetadataId?: string; operand?: string}`. If Twenty's API envelope changes (e.g., `fieldMetadataId` is renamed to `fieldId`, or the row shape gains a wrapper level), `parseInnerOrGraphqlArray` will succeed — it only validates the top-level array shape — but the filter at line 364 will silently return an empty `leakedRows` array, and `expect(leakedRows).toEqual([])` at line 369 will pass vacuously. The verification that "the bad filter row did NOT land" becomes unverifiable. This was explicitly noted as deferred in `issue-14-low-sweep.md` §Out-of-scope with a filed follow-up requirement, but no issue was actually filed until now.

## Reproduction

```bash
# Unit-level demonstration of the silent-pass risk (no live stack needed):
# The verification block at lines 360-369 of round-trip.test.ts performs:
#   const viewFilterRows = parseInnerOrGraphqlArray<{fieldMetadataId?:string; operand?:string}>(text)
#   const leakedRows = viewFilterRows.filter(row => row.fieldMetadataId === DATE_TIME_FIELD_ID && ...)
#   expect(leakedRows).toEqual([])
#
# If the API renames the property:
#   [{fieldId: "some-uuid", operand: "GREATER_THAN_OR_EQUAL"}]
# Then viewFilterRows will contain rows where .fieldMetadataId is undefined,
# the filter returns [], and the expect passes — silently.
#
# This cannot be demonstrated without a live stack, but the code path is
# mechanically evident at round-trip.test.ts:360-369.
```

Reproduction: not fully derivable without a running stack (the integration test requires `TWENTY_MCP_INTEGRATION=1`). The silent-pass risk is mechanically evident from static code inspection at `round-trip.test.ts:360–369` — see Problem statement.

## Root cause hypothesis

`packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:360–369` uses a bare TypeScript generic `<{fieldMetadataId?: string; operand?: string}>` to type the view-filter rows. TypeScript generics are compile-time only; at runtime, the parsed rows have no shape validation. `parseInnerOrGraphqlArray` (in `packages/twenty-mcp/src/utils/parse-metadata-array.ts`) validates only that the top-level response is an array — it does not validate the shape of array elements. The consequence: any field rename or structural change in Twenty's `view_filters` response is invisible to the test, causing the verification assert to pass vacuously. The deferred item in `issue-14-low-sweep.md` §Out-of-scope identified this risk but explicitly deferred it, requiring a follow-up issue to be filed. That issue was not filed at the time; issue #17 closes that gap.

## Proposed fix

1. **Define a Zod schema for view-filter rows** in `packages/twenty-mcp/src/utils/parse-metadata-array.ts` (or a new collocated file `view-filter-row.schema.ts`):
   ```typescript
   import { z } from 'zod';
   export const viewFilterRowSchema = z.object({
     fieldMetadataId: z.string().uuid(),
     operand: z.string().min(1),
   });
   export type ViewFilterRow = z.infer<typeof viewFilterRowSchema>;
   ```
   The schema must use `z.string().uuid()` for `fieldMetadataId` (not `z.string()`) so that a UUID rename producing a non-UUID value fails loudly rather than passing with `undefined`.

2. **Update `round-trip.test.ts:360–369`** to replace the bare generic with a Zod parse call:
   ```typescript
   import { viewFilterRowSchema } from '../../utils/view-filter-row.schema'; // or parse-metadata-array
   // ...
   const rawRows = parseInnerOrGraphqlArray<unknown>(viewFiltersText);
   const viewFilterRows = viewFilterRowSchema.array().parse(rawRows);
   ```
   Any future shape drift in Twenty's `view_filters` response now surfaces as a loud Zod `ZodError` rather than a silent empty-filter pass.

3. The `leakedRows` filter and `expect(leakedRows).toEqual([])` assertion at lines 364–369 remain unchanged — they test the correct thing once the rows are shape-validated.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] Run the full unit suite to confirm the new Zod schema file parses correctly (TypeScript compile + jest):
  ```bash
  cd packages/twenty-mcp && npx jest --testTimeout 10000
  # Expected: all tests pass (green); Zod import resolves; no type errors
  ```
- [ ] Typecheck the package to confirm no new `noImplicitAny` or import errors:
  ```bash
  cd packages/twenty-mcp && npx tsc --noEmit
  # Expected: zero errors
  ```
- [ ] Unit-level adversarial test for the new schema — add to the test suite (e.g., `parse-metadata-array.test.ts` or a new `view-filter-row.schema.test.ts`):
  ```bash
  # In the test file, add:
  #   it('viewFilterRowSchema rejects row with missing fieldMetadataId', () => {
  #     expect(() => viewFilterRowSchema.parse({operand: 'eq'})).toThrow(z.ZodError);
  #   });
  #   it('viewFilterRowSchema rejects row with non-UUID fieldMetadataId', () => {
  #     expect(() => viewFilterRowSchema.parse({fieldMetadataId: 'not-a-uuid', operand: 'eq'})).toThrow(z.ZodError);
  #   });
  #   it('viewFilterRowSchema accepts valid row', () => {
  #     expect(() => viewFilterRowSchema.parse({fieldMetadataId: '00000000-0000-0000-0000-000000000000', operand: 'eq'})).not.toThrow();
  #   });
  cd packages/twenty-mcp && npx jest src/__tests__/view-filter-row.schema.test.ts --testTimeout 10000
  # Expected: 3 tests pass
  ```
- [ ] (Integration — requires local stack) Confirm the integration test's verification block throws loudly if rows lack `fieldMetadataId`:
  ```bash
  TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
    npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts \
    --testNamePattern "GREATER_THAN_OR_EQUAL on DATE_TIME" --testTimeout 30000
  # Expected: PASS — rows returned by Twenty pass schema validation; leakedRows is empty
  ```

## Failure modes named (R3: adversarial pre-mortem)

1. **Zod schema is too strict, breaking on a workspace that has extra fields in view-filter rows**: if Twenty returns extra properties (e.g., `displayValue`, `createdAt`) and the schema uses `z.object({...}).strict()` instead of the default passthrough, every test workspace will throw a ZodError even when correct. Mitigation: use `z.object({...})` (default passthrough mode — extra keys are silently stripped) rather than `.strict()`. The schema only validates the two fields the test asserts on.

2. **Schema is defined but not used in the parse call**: implementer defines `viewFilterRowSchema` but accidentally leaves the bare generic `<{fieldMetadataId?: string; operand?: string}>` in the test, so the Zod validation never runs at integration time. Mitigation: test plan item 3 (unit-level adversarial test for the schema) must exist and pass — but it only confirms the schema itself is valid, not that it's called in `round-trip.test.ts`. Add an explicit grep in the PR review:
   ```bash
   grep 'viewFilterRowSchema.array().parse\|viewFilterRowSchema\.array()\.parse' \
     packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts
   # Expected: at least one match
   ```

3. **`viewFilterRowSchema` placed in `parse-metadata-array.ts` creates a circular import** if `round-trip.test.ts` also imports `parseInnerOrGraphqlArray` from that file (it does — line 24). Zod is already a dependency of `twenty-mcp`; adding a Zod schema to `parse-metadata-array.ts` should not create a cycle. Mitigation: if the TypeScript compiler reports a circular import, move the schema to a new dedicated file `src/utils/view-filter-row.schema.ts` and update the import. The `npx tsc --noEmit` step in the test plan catches this before commit.

## Out of scope

- Adding Zod validation to ALL `parseInnerOrGraphqlArray` call sites in `round-trip.test.ts` — this plan is scoped to the view-filter row verification block at lines 360–369, which is the one identified in the deferred item. Other call sites (people CRUD, note-target linking) have structural shapes (`{id: string}`) that are already asserted directly on the unwrapped result. Worst case if deferred for those sites: same Tested-because-mock-passes class — acceptable because the structural assertions (e.g., `expect(r.result?.id).toBeTruthy()`) do provide some shape-level protection.
- Adding Zod validation to `parseInnerOrGraphqlArray` itself (making it generic over a Zod schema) — this would be a broader API change touching all callers. Deferred as a separate improvement if the pattern proves valuable across multiple call sites.

## References

- packages/twenty-mcp/CLAUDE.md (L2: "Mocks pass when the spec passes — that's not correctness." + R4 evaluation rule)
- packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:353–369 (view-filter verification block)
- packages/twenty-mcp/src/utils/parse-metadata-array.ts (parseInnerOrGraphqlArray — adds top-level shape validation only)
- packages/twenty-mcp/plans/issue-14-low-sweep.md (§Out-of-scope clause that deferred this item)
- packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness.md (original HIGH-2 that established the parseInnerOrGraphqlArray pattern)
- packages/twenty-mcp/plans/issue-14-low-sweep-audit-round-1.md (audit that filed this as a follow-up issue)

## Implementation notes
> Implemented: 2026-05-12T00:00:00Z

### Files changed
packages/twenty-mcp/src/utils/view-filter-row.schema.ts (NEW)
packages/twenty-mcp/src/__tests__/view-filter-row.schema.test.ts (NEW)
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts (MODIFIED: import + parse call)

### Diff stat
 packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts  |  5 ++---
 packages/twenty-mcp/src/__tests__/view-filter-row.schema.test.ts  | 27 +++++++++++++++++++++++++++
 packages/twenty-mcp/src/utils/view-filter-row.schema.ts           | 19 +++++++++++++++++++
 3 files changed, 48 insertions(+), 3 deletions(-)

### Test results

**Test 1: Full unit suite**
```
Test Suites: 17 passed, 17 total
Tests:       221 passed, 221 total
```
PASS — 3 new schema tests + 218 existing = 221.

**Test 2: npx tsc --noEmit**
```
(no output)
exit: 0
```
PASS — zero TypeScript errors.

**Test 3: view-filter-row.schema.test.ts (3 tests)**
```
PASS src/__tests__/view-filter-row.schema.test.ts
  viewFilterRowSchema
    ✓ rejects row with missing fieldMetadataId (8 ms)
    ✓ rejects row with non-UUID fieldMetadataId (1 ms)
    ✓ accepts valid row (1 ms)
Tests: 3 passed, 3 total
```
PASS

**Test 4: Integration test (GREATER_THAN_OR_EQUAL on DATE_TIME) against local stack**
```
PASS src/__tests__/integration/round-trip.test.ts
  ✓ apply_plan CREATE_VIEW_FILTER with GREATER_THAN_OR_EQUAL on DATE_TIME is rejected by the proxy (never reaches Twenty) (207 ms)
Tests: 26 skipped, 1 passed, 27 total
```
PASS — Zod schema validation ran against live Twenty data; rows passed schema; leakedRows is empty.

**Verification grep for viewFilterRowSchema.array().parse**
```
362:      const viewFilterRows = viewFilterRowSchema.array().parse(rawRows);
```
PASS — schema is called in round-trip.test.ts (not just defined and ignored).

### Surprises
The schema was placed in a new `src/utils/view-filter-row.schema.ts` file per the plan's Failure mode #3 mitigation. No circular import issue arose. The integration test ran against the live local stack and passed; Twenty's view_filters response rows have `fieldMetadataId` as a valid UUID, confirming there is no current shape drift.

> Audit round 1: LOW backlogged (foot-gun): viewFilterRowSchema.array().parse([]) vacuous on zero-rows — see [issue-16-17-18-clubbed-audit-round-1.md](issue-16-17-18-clubbed-audit-round-1.md)
