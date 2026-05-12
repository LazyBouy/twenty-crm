# Plan: views-coverage spread-parser regression test is white-box duplicate, not production-path exercise

> Issue(s): #16
> Package: packages/twenty-mcp
> Severity: medium
> Worst-case bug class if deferred: Tested-because-mock-passes — the production balanced-bracket scanner (views-coverage.test.ts:144–159) can be reverted to a non-greedy regex and the regression test at lines 175–213 still passes because it exercises a duplicated copy of the algorithm, not the production code path (L2/R6 from packages/twenty-mcp/CLAUDE.md)
> Created: 2026-05-12

## Problem statement

The regression test added by issue #14 (item 6) in `packages/twenty-mcp/src/__tests__/views-coverage.test.ts:175–213` verifies the balanced-bracket scan by inlining a byte-identical copy of the scanner loop and running it against a synthetic nested-array input. The test does NOT call the production scanner at `views-coverage.test.ts:144–159`, which is the actual code that runs when `parseTwentyFrontMap()` parses `twenty-front`'s `FILTER_OPERANDS_MAP`. The two implementations are entirely decoupled: a developer can replace lines 144–159 with a non-greedy regex (`[\s\S]*?\]`) and the regression test at lines 175–213 continues to pass with "FIRST, NESTED_INNER, THIRD". The invariant the test claims to protect — "the production scanner does not close on the first `]`" — is not actually protected.

## Reproduction

```bash
# Step 1: demonstrate the test passes even if you break the production scanner.
# Without editing any file, run the existing regression test to see it green:
cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts \
  --testNamePattern "balanced-bracket scanner" --testTimeout 10000
# Expected: PASS — the test exercises an inline copy, not the production function.

# Step 2: verify the production scanner lives at lines 144-159 of the test file,
# and that it is NOT called from the regression test (lines 175-213):
grep -n 'parseTwentyFrontMap\|bDepth\|bracketStart' \
  packages/twenty-mcp/src/__tests__/views-coverage.test.ts
# Expected: parseTwentyFrontMap() is called only in the two later tests
# (lines 216+); bDepth/bracketStart live at 148-159 (production) and 194-200
# (inline copy in the regression test). They share no call boundary.
```

## Root cause hypothesis

`packages/twenty-mcp/src/__tests__/views-coverage.test.ts:175–213` is a self-contained `it(...)` block that duplicates the balanced-bracket scanner inline (lines 194–205) rather than extracting the production scanner into a shared helper and calling that helper. The production scanner embedded in `parseTwentyFrontMap()` (lines 143–159 of the same file) is a non-exported closure. Because it is a closure, the regression test cannot import it — so the test author copied the algorithm instead. The result is a L2 ("Tested-because-mock-passes") violation: the test and the implementation are byte-identical today, but any future divergence (e.g., a bug introduced into lines 143–159 only) goes undetected until `parseTwentyFrontMap()` is called with a real spread-containing `FILTER_OPERANDS_MAP` input at runtime.

## Proposed fix

Extract the balanced-bracket scan from the inline closure inside `parseTwentyFrontMap()` into a small **exported** helper, then call that helper from both the production scan path and the regression test. Concretely:

1. **`packages/twenty-mcp/src/__tests__/views-coverage.test.ts`** — extract the balanced-bracket scanner (lines 143–159, the `bDepth`/`bEnd` loop) into an exported function `sliceBalancedBracket(source: string, openPos: number): string` that returns the content between the opening `[` at `openPos` and its matching `]`. The function should:
   - Start at `openPos` (assumed to be the index of the opening `[`).
   - Walk forward incrementing `depth` on `[`, decrementing on `]`.
   - Return `source.slice(openPos + 1, matchingClose)` (the inner content, not including the brackets).
   - Throw if no matching `]` is found (depth never returns to 0).

2. **Update `parseTwentyFrontMap()`** to call `sliceBalancedBracket(source, bracketStart)` instead of the inline loop.

3. **Update the regression test at lines 175–213** to call `sliceBalancedBracket(fakeSource, bracketStart)` and assert on its return value. The inline loop copy (lines 194–205) is deleted; the regression test now exercises production code.

4. The two `it(...)` tests at lines 215–245 (`FIELD_TYPE_OPERAND_MAP has the same field types…` and `…has the same operand lists…`) already call `parseTwentyFrontMap()` — they are unaffected by the refactor and continue to serve as end-to-end structural guards.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] Run the full views-coverage test suite to confirm all three tests pass after the refactor:
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts --testTimeout 10000
  # Expected: 3 tests pass — balanced-bracket regression guard + 2 structural map tests
  ```
- [ ] Confirm the regression test no longer contains a duplicated scanner loop by asserting only one occurrence of the scan variable name exists in the file:
  ```bash
  grep -c 'bDepth\|depth++\|depth--' packages/twenty-mcp/src/__tests__/views-coverage.test.ts
  # Expected: the variable names from the inline copy are gone; only the
  # exported helper's implementation remains (≤ 6 occurrences total — 1 definition)
  ```
- [ ] Adversarial regression check — temporarily introduce a deliberate bug in `sliceBalancedBracket` (e.g., change `depth === 0` to `depth <= 1`) and confirm the regression test catches it:
  ```bash
  # After introducing the deliberate bug:
  cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts \
    --testNamePattern "balanced-bracket scanner" --testTimeout 10000
  # Expected: FAIL — "expected ['FIRST', 'NESTED_INNER', 'THIRD'] but got ['FIRST']"
  # (or equivalent mismatch depending on the introduced bug)
  # Then revert the deliberate bug before committing.
  ```
- [ ] Run the full unit suite to confirm no other test is broken:
  ```bash
  cd packages/twenty-mcp && npx jest --testTimeout 10000
  # Expected: all tests pass (green)
  ```

## Failure modes named (R3: adversarial pre-mortem)

1. **The extracted `sliceBalancedBracket` function is tested but not called from `parseTwentyFrontMap()`**: the implementer exports the helper and updates the regression test, but forgets to replace the inline loop in `parseTwentyFrontMap()`. The regression test is now correct, but the production path still has the old inline loop — a future bug in the production inline loop is undetected. Mitigation: test plan item 2 (grep for scanner variable names) will fail if both copies still exist; additionally, test plan item 3 (adversarial deliberate bug) must be run against the production helper path (`parseTwentyFrontMap()` calls `sliceBalancedBracket`) to be meaningful.

2. **`sliceBalancedBracket` throws on a real twenty-front source file** due to an edge case not covered by the synthetic `fakeSource`: for example, a template literal containing `[` characters inside a field-type entry. Mitigation: the two structural map tests (lines 215–245) call `parseTwentyFrontMap()` against the real `twenty-front` source file via `TWENTY_FRONT_SOURCE` — if `sliceBalancedBracket` throws there, those tests fail loudly.

3. **The function is exported but still embedded in the test file**, making it inaccessible to future callers outside the test suite: as a production utility, `sliceBalancedBracket` belongs in a utility module, not a test file. If a second caller needs it (e.g., a new spread-handling test), they import from the test file — which jest may or may not resolve depending on module boundaries. Mitigation: accept this risk for this plan's scope; if a second caller emerges, move the helper to `src/utils/`. Flag: the current caller (the test file) and the production call site are in the same file, so export-from-test-file is the minimal-change approach.

## Out of scope

- Refactoring `parseTwentyFrontMap()` itself beyond extracting the scanner — the function is a source-parser with known boundaries and is tested end-to-end by the structural map tests. A broader refactor is a separate concern. Worst case if deferred: none beyond the current foot-gun already present.
- Moving `sliceBalancedBracket` to a dedicated utility file — acceptable to leave in the test file for this fix; promotes to `src/utils/` only if a second caller appears.

## References

- packages/twenty-mcp/CLAUDE.md (L2: "Mocks pass when the spec passes — that's not correctness." + R4/R6 evaluation rules)
- packages/twenty-mcp/src/__tests__/views-coverage.test.ts:143–213 (production scanner + regression test)
- packages/twenty-mcp/plans/issue-14-low-sweep.md (item 6: the sweep item that introduced the regression test)
- packages/twenty-mcp/plans/issue-14-low-sweep-audit-round-1.md (audit that identified this as HIGH-2 follow-up filed as issue #16)
