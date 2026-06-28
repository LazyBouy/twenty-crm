# Low-priority audit findings backlog — twenty-front

Findings that the audit pipeline categorised as `foot-gun` or `cosmetic`. Each entry is **queued** until the sweep threshold fires (count ≥ 5 by default, or manual via `/sweep-lows --force`); at sweep time, the queued entries are bundled into a single GitHub issue and run through the standard `/triage-issues → /implement-issue-fix → /audit-fix → /close-issue` pipeline. Swept entries move to the `Swept (history)` table for institutional memory; they are NOT deleted.

Threshold: `5` queued items. See `.claude/skills/sweep-lows/SKILL.md` for sweep mechanics; see `plans/2026-05-02-low-handling-policy.md` for the policy rationale.

## Queued

| Added | Source audit | Subcategory | One-line description | Suggested resolution |
|---|---|---|---|---|
| 2026-06-28 | [issue-25-...-audit-round-1.md](issue-25-infer-type-appropriate-default-icon-for-icon-less-fields-audit-round-1.md) (LOW-1) | foot-gun | `getDefaultIconForFieldType`'s `FIELD_TYPE_ICON_MAP` maps 20 of 25 `FieldMetadataType` values; ACTOR/NUMERIC/POSITION/RICH_TEXT/TS_VECTOR fall to `Icon123` in the field/column/filter picker, while the settings new-field form's `DEFAULT_ICONS_BY_FIELD_TYPE` maps those same 5 to `IconUsers` — a cross-surface inconsistency (no regression; `Icon123` was the pre-fix default for all types) | when consolidating the two maps (see the duplicate-map item), add the 5 missing entries — either mapped to a sensible icon or explicitly to `Icon123` so the intent is recorded |
| 2026-06-28 | [issue-25-...-audit-round-1.md](issue-25-infer-type-appropriate-default-icon-for-icon-less-fields-audit-round-1.md) (LOW-2) | foot-gun | the type→icon map is now duplicated across `object-metadata/utils/getDefaultIconForFieldType.ts` (new) and `pages/settings/data-model/constants/DefaultIconsByFieldType.ts` (authoritative) with only a code-comment "keep in sync" — no mechanical guard, so a future contributor editing one will not be alerted to the other (drift → wrong icons) | consolidate into one shared constant (candidate home: `twenty-shared/` or a shared `object-metadata` constant the settings page imports); optionally type it `Record<FieldMetadataType, string>` so a new enum value forces a compile error (closes the silent-`Icon123`-default gap too) |

## Swept (history)

| Swept on | Sweep issue | Items | Plan path | Closed in |
|---|---|---|---|---|

## Absorbed pre-commit (history — for traceability of trivial-in-place LOWs that didn't go through the backlog)

| Date | Source audit | Subcategory | One-line description | Absorbed in commit |
|---|---|---|---|---|

## Filed as separate issues (history — for traceability of cross-cutting LOWs)

| Date | Source audit | One-line description | Issue number |
|---|---|---|---|
