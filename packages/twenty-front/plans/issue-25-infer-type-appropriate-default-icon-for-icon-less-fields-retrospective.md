# Retrospective: Infer a type-appropriate default icon instead of always Icon123

> Issue(s): #25
> Plan: packages/twenty-front/plans/issue-25-infer-type-appropriate-default-icon-for-icon-less-fields.md
> Audit cycles: 1 (clean on first pass)
> Commit: <pending — filled by closer post-commit>
> Written: 2026-06-28T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Unit test — full type-to-icon mapping (12 type→icon assertions incl. NUMERIC/ACTOR→Icon123) | Delivered exactly; 12 tests green. Asserts concrete icon names, not mock-passes. |
| Unit test — `formatFieldMetadataItemAsFieldDefinition` uses type-inferred icon for null/undefined, preserves explicit icon | Delivered; 3 tests green covering null→IconCalendarClock, undefined→IconTag, explicit IconCustom preserved. |
| Icon names exist in twenty-ui (mechanical grep before coding) | Confirmed independently by auditor: all 20 names + Icon123 fallback resolve in `AllIcons.ts` (dual-registered). No blank-render risk. |
| TypeScript typecheck passes | PASS — tsgo exit 0. |
| Lint diff passes | `lint:diff-with-main` is a no-op for untracked files; validated directly with oxlint `--type-aware` (0/0) + prettier `--check` (clean). |
| Failure mode 1 — `FieldMetadataType` nominal mismatch (twenty-shared vs generated-metadata) | Did not surface. The edited file already compares `field.type` against the twenty-shared enum, so the types are codebase-compatible; no `as string` cast needed. Mitigation held. |
| Failure mode 2 — future enum value falls to Icon123 silently (Partial<Record>) | Confirmed present and intentional. Recorded as a foot-gun LOW (no exhaustiveness guard). |
| Failure mode 3 — settings map and new-util map drift apart | Confirmed structural; recorded as a foot-gun LOW. Both maps correct today. |

## Audit journey

Round 1 (final): clean. All mechanical gates green (typecheck, oxlint, prettier, 15 unit tests). Every icon name independently verified against the runtime registry. 14 adjacent callers inspected — none depended on the literal `'Icon123'`; no pre-existing test for the modified function, so no silent regression. Two foot-gun LOWs recorded (5 unmapped enum values; duplicated map). Zero critical, zero high. Proceeded to retrospective.

## Defects routed but not blocking

- Filed as new issues (medium): none.
- Annotated as low: 2, both FOOT-GUN → `packages/twenty-front/plans/low-backlog.md` Queued table:
  1. `FIELD_TYPE_ICON_MAP` omits ACTOR/NUMERIC/POSITION/RICH_TEXT/TS_VECTOR (fall to Icon123; settings maps them to IconUsers).
  2. Duplicated type→icon map across `object-metadata/` and `settings/` with no mechanical sync guard.

## Surprises

- `lint:diff-with-main` reports "No changed files" for untracked/unstaged files (diffs `main...HEAD`). Confirms the headline lesson from issue #22: a green jest run is not a green lint gate, and `lint:diff-with-main` silently passes pre-commit work. Direct oxlint + prettier invocation on the explicit file list is the correct substitute and was used.
- The implementer hit three prettier collapse-to-single-line violations and fixed them manually (no auto-fixer); the audited files re-check clean under `prettier --check`.
- The plan's icon-existence grep (`export.*IconName`) returns 10 because it incidentally matches `IllustrationIcon*` variants. The authoritative existence check is `AllIcons.ts` (the runtime registry), which the auditor used directly — all 20 names confirmed there.

## Lessons for institutional memory

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L: When a fix duplicates an existing constant/map "to avoid a cross-module import," verify the copy is a *complete* subset+superset of the source — a partial copy (here 20/25 enum values) creates a cross-surface inconsistency that looks like a regression. | (n/a — too narrow / one-off) | This is a sensible per-fix judgement already captured as a foot-gun LOW; the plan consciously scoped the 5-value gap. Not a repo-wide rule worth ingraining. |
| L: For twenty-front icon-name defaults, the authoritative existence check is `packages/twenty-ui/src/display/icon/providers/internal/AllIcons.ts` (the runtime registry), not a loose `export.*Icon` grep (which matches `IllustrationIcon*`). | `packages/twenty-front` (no existing Lessons file) — candidate: a short note where icon utils live, or root `CLAUDE.md` if a home is wanted | Re-usable for any future "default icon for X" fix in twenty-front; prevents a false-positive existence check. Supervisor decides whether it warrants a home vs being left in this retrospective. |
| (n/a) | (no ingrain) | The lint-gate-blind-spot lesson (lint:diff-with-main no-ops untracked files; verify with direct oxlint+prettier) is already ingrained from issue #22 — no new ingrain needed, just reconfirmed here. |

## Diff summary

```
 .../object-metadata/utils/formatFieldMetadataItemAsFieldDefinition.ts  | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)
```

Plus 3 new untracked files (191 lines total):
- `getDefaultIconForFieldType.ts` (32)
- `__tests__/getDefaultIconForFieldType.test.ts` (75)
- `__tests__/formatFieldMetadataItemAsFieldDefinition.test.ts` (84)
