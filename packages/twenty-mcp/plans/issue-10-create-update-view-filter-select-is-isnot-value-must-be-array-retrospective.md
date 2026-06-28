# Retrospective: create_view_filter / update_view_filter — SELECT IS/IS_NOT value must be array

> Issue(s): #10
> Plan: plans/issue-10-create-update-view-filter-select-is-isnot-value-must-be-array.md
> Audit cycles: 1 (clean on round 1)
> Commit: <pending — filled by closer post-commit>
> Written: 2026-06-28T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Unit test — direct handler coerces string→array (create) | PASS — `views.test.ts:358` asserts forwarded `value === ['TIER_A']`. Mechanically verified. |
| Unit test — no double-wrap of existing array (create) | PASS — `views.test.ts:379` asserts `['TIER_A']` stays `['TIER_A']`. |
| Unit test — coerces string→array (update, IS_NOT) | PASS — `views.test.ts:423` asserts `['TIER_B']`. |
| Unit test — TEXT CONTAINS not coerced | PASS — `views.test.ts:400` asserts `value === 'foo'`. |
| Unit test — apply_plan CREATE_VIEW_FILTER coerces | PASS — `metadata.test.ts:1108` asserts `['TIER_A']`; plus a no-double-wrap test at `:1139`. |
| Full unit suite green | PASS — 17 suites / 230 tests. |
| Coverage test still passes (no describe-text drift) | PASS — coverage + contract + views-coverage all green (37 tests). |
| Failure mode 1: `assertOperandCompatible` return-type change breaks TS callers; unknownType path skips coercion | Held. Optional `fieldType?` is backward-compatible (typecheck clean); unknownType returns no `fieldType` → `=== 'SELECT'` guard correctly skips coercion. |
| Failure mode 2: apply_plan coercion fires when operand undefined | Held. Coercion is nested inside `typeof operand === 'string'` guard at both update sites; never fires on operand-absent updates. Verified by `value-only passes through` test. |
| Failure mode 3: MULTI_SELECT IS string needs array but helper is SELECT-only | Held as designed — explicitly deferred. The diff does not coerce MULTI_SELECT; documented out-of-scope. Audit re-flagged it as a named follow-up (not a defect in this diff). |

## Audit journey

Round 1 (final): clean. All mechanical gates passed (typecheck, prettier — which is the full lint gate for twenty-mcp since no eslint/oxlint target exists, full jest suite, coverage/contract). All three coercion sites verified symmetric; every adversarial probe (double-wrap, operand-undefined, non-SELECT, unknownType, non-null-assertion safety, const→let) verified clean against the tests. One LOW found: a stale SELECT value-rule string surviving in the `metadata_create_view_filter` tool-level description (views.ts:598) — the same misleading text the plan corrected on the two schema `.describe()` calls but missed in the third (tool description) location. Routed trivial-in-place (absorb pre-commit); not blocking because the Part-B coercion makes the stale guidance harmless to row correctness.

## Defects routed but not blocking

- Filed as new issues (medium): none
- Annotated as low: 1 — LOW-1 (trivial-in-place), stale `option value (UPPER_SNAKE_CASE)` string at views.ts:598; absorb pre-commit per routing policy. See the round-1 audit report for the exact edit.

## Surprises

- The implementer flagged `effectiveArgs` was `const` (plan asked to verify) and changed it to `let` with an explanatory comment — correct; only one re-assignment site (the spread-replace), no other writer.
- Prettier flagged the multi-arg `coerceSelectIsValue(...)` call in `metadataUpdateViewFilter` at 81 chars; implementer reflowed to the wrapped form. Confirmed clean at audit.
- Live round-trip not run (no local stack) — consistent with the plan, which records the issue reporter already confirmed the live reproduction and the plan's test plan is unit-only.
- Auditor surprise: the misleading SELECT string existed in THREE places, not two. The plan's "Part A" anchors named only the two schema `.describe()` calls (views.ts:351, 364-375); the tool-description occurrence (views.ts:598) was outside the plan's file:line anchors and was therefore missed by both plan and implementer. This is precisely the L6 "audit tool descriptions when schemas change" miss — caught by the auditor's grep-for-all-occurrences pass, not by the plan's anchored line list.

## Lessons for institutional memory

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L_describe_vs_description: a misleading value/shape rule typically lives in BOTH the Zod field `.describe()` AND the tool-level `description` field. When a plan corrects schema describe-text, grep the whole tool file for every occurrence of the wrong string before declaring Part A done — the plan's anchored file:line list is necessary but not sufficient. | `packages/twenty-mcp/CLAUDE.md` (Lessons table — extends existing L6) | L6 already says "Tool descriptions ARE the contract … audit them when schemas change." This issue is the concrete instance where the schema describe was fixed but the sibling tool-description string was missed because it sat outside the plan's anchors. Reinforces L6 with the grep-all-occurrences discipline. This is a twenty-mcp wrapper specificity (two-tier describe/description). |
| (n/a) | (no ingrain — too narrow) | The coercion-helper symmetry-at-three-sites discipline is already captured by the existing issue-#3 plan reference and the package's R-rules; nothing new to ingrain there. |

## Diff summary

```
 packages/twenty-mcp/src/__tests__/metadata.test.ts | 64 +++++++++++++++
 packages/twenty-mcp/src/__tests__/views.test.ts    | 90 ++++++++++++++++++++++
 packages/twenty-mcp/src/tools/metadata.ts          | 15 +++-
 packages/twenty-mcp/src/tools/views.ts             | 55 +++++++++++--
 4 files changed, 218 insertions(+), 6 deletions(-)
```
