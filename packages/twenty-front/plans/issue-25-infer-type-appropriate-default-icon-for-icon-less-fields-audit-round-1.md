# Audit report: Infer a type-appropriate default icon instead of always Icon123 — round 1

> Plan: packages/twenty-front/plans/issue-25-infer-type-appropriate-default-icon-for-icon-less-fields.md
> Round: 1
> Audited: 2026-06-28T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-front`) | PASS | tsgo exit 0, zero errors. No nominal `FieldMetadataType` mismatch — see analysis below. |
| Lint — oxlint `--type-aware` on the 4 changed files | PASS | Found 0 warnings and 0 errors (29 rules, 4 files). |
| Lint — prettier `--check` on the 4 changed files | PASS | All matched files use Prettier code style. |
| Lint — `nx lint:diff-with-main` | N/A (expected) | Reports "No changed files" because new files are untracked and the gate diffs `main...HEAD` (committed only). Validated directly via oxlint + prettier above, per supervisor instruction. |
| Unit suite (2 new test files) | PASS | 2 suites, 15 tests passed, 1.187s. |
| Adjacent-callers check | OK | 14 callers of `formatFieldMetadataItemAsFieldDefinition` inspected; all consume `iconName` for display only — none relied on the literal `'Icon123'`. No sibling-test regression (no pre-existing test for this function; the two `Icon123` references in the repo's tests are unrelated side-panel/icon-picker fixtures). |

### Independent icon-existence verification (highest-risk check for this fix)

All 20 icon names in `FIELD_TYPE_ICON_MAP`, plus the `'Icon123'` fallback, were independently grepped against the runtime registry `packages/twenty-ui/src/display/icon/providers/internal/AllIcons.ts`. Every name resolves (each registered twice — the dual-registration pattern, confirmed e.g. `IconCalendarClock` at lines 946 and 5130). `IconUsers` (used by the settings source-of-truth for the 5 unmapped types) also exists. No blank-render risk. Result:

```
OK: IconMap IconToggleLeft IconMoneybag IconCalendarEvent IconCalendarClock
OK: IconFile IconUserCircle IconTags IconNumber9 IconStar IconBraces
OK: IconRelationOneToMany IconTag IconTypography IconId IconBracketsContain
OK: IconMail IconWorld IconPhone Icon123
```

### Type-mismatch analysis (plan failure mode 1)

`getDefaultIconForFieldType(type: FieldMetadataType)` imports `FieldMetadataType` from `twenty-shared/types`; the edited file `formatFieldMetadataItemAsFieldDefinition.ts` imports the same enum from the same path and passes `field.type` to it. `field.type` derives (via `FieldMetadataItem = Omit<Field, ...>`) from generated-metadata `Field.type`, but the rest of the file already compares `field.type === FieldMetadataType.RELATION` against the `twenty-shared/types` enum (lines 27–28), so the codebase already treats these as compatible. Typecheck is green — no nominal mismatch surfaced. The plan's mitigation held; no `as string` cast was needed.

### Mapping correctness

Each mapped value is semantically appropriate: `DATE`→`IconCalendarEvent`, `DATE_TIME`→`IconCalendarClock`, `BOOLEAN`→`IconToggleLeft`, `SELECT`→`IconTag`, `MULTI_SELECT`→`IconTags`, `RELATION`/`MORPH_RELATION`→`IconRelationOneToMany`, `EMAILS`→`IconMail`, `PHONES`→`IconPhone`, `LINKS`→`IconWorld`, `RATING`→`IconStar`, `NUMBER`→`IconNumber9`, etc. The new util's 20 entries are byte-for-byte identical to the corresponding 20 entries in the authoritative `DEFAULT_ICONS_BY_FIELD_TYPE`. No misleading icon found.

### Test substance

Non-vacuous. `getDefaultIconForFieldType.test.ts` asserts 12 concrete (type → exact icon name) pairs including the two intended `Icon123` fall-throughs (NUMERIC, ACTOR). `formatFieldMetadataItemAsFieldDefinition.test.ts` asserts (a) `icon: null` → type-inferred (`IconCalendarClock`), (b) `icon: undefined` → type-inferred (`IconTag`), and (c) explicit `icon: 'IconCustom'` is preserved (not overridden). The explicit-icon short-circuit (`field.icon ?? ...`) is confirmed both by reading line 63 and by test (c). These are real assertions against production behaviour, not mock-passes.

## Defects found

### CRITICAL — none

### HIGH — none

### MEDIUM — none

### LOW

1. **`FIELD_TYPE_ICON_MAP` omits 5 enum values that the authoritative source maps to `IconUsers`** [FOOT-GUN] (getDefaultIconForFieldType.ts:7-28)
   - What: The new util maps 20 of the 25 `FieldMetadataType` values. ACTOR, NUMERIC, POSITION, RICH_TEXT, TS_VECTOR are unmapped and fall to `'Icon123'`. The source-of-truth `DEFAULT_ICONS_BY_FIELD_TYPE` (settings) maps all 5 to `'IconUsers'`. So a NUMERIC/POSITION/RICH_TEXT field rendered through the field picker shows the numbers icon (`Icon123`) while the same type shows `IconUsers` in the settings new-field form — a minor cross-surface inconsistency.
   - Why low: The plan explicitly scopes these out (failure mode 2; a test asserts NUMERIC/ACTOR→`Icon123` as *intended*). `Icon123` is the pre-fix behaviour for every type, so this is no regression for the 5 unmapped types — it is simply "fix didn't reach them." `IconUsers` itself is a generic placeholder in the settings copy, so the picker isn't meaningfully more wrong than the form. NUMERIC/POSITION/TS_VECTOR are also rarely user-facing custom-field types.
   - Subcategory rationale: FOOT-GUN rather than CROSS-CUTTING because it only bites if someone later expects the picker and the form to agree for these 5 types; there is no active user-facing breakage today, and the divergence is documented in the plan. Not COSMETIC because it is a behavioural (icon-value) difference, not style.
   - Suggested action: backlog (foot-gun): the picker default for ACTOR/NUMERIC/POSITION/RICH_TEXT/TS_VECTOR is `Icon123` while settings uses `IconUsers`; resolution: when consolidating the two maps (see low #2) add these 5 entries (or consciously decide `Icon123` is the better generic for the picker and add them mapped to `Icon123` for explicitness).

2. **Duplicated type→icon map across `object-metadata/` and `settings/` will drift** [FOOT-GUN] (getDefaultIconForFieldType.ts vs pages/settings/data-model/constants/DefaultIconsByFieldType.ts)
   - What: Two near-identical maps now exist. The new util documents in a comment that it must be kept in sync, but there is no mechanical guard — a future contributor adding/altering one will not be alerted to the other.
   - Why low: No current defect; both maps are correct today. The plan deliberately accepts the duplication to avoid a cross-module import from `object-metadata/` into `settings/` and keep the diff to one file.
   - Subcategory rationale: FOOT-GUN not CROSS-CUTTING because nothing is wrong now and an issue would likely be triaged as wontfix until a real consolidation is scheduled; the risk is purely "latent on a future edit." Escalated above COSMETIC because drift would produce wrong icons, a functional effect.
   - Suggested action: backlog (foot-gun): consolidate `FIELD_TYPE_ICON_MAP` and `DEFAULT_ICONS_BY_FIELD_TYPE` into one shared constant (candidate home: `twenty-shared/` or a shared `object-metadata` constant the settings page imports); resolution: single source of truth + optionally an exhaustiveness `Record<FieldMetadataType, string>` so a new enum value forces a compile error.

## Adversarial pre-mortem (R3 against the diff)

1. **A NUMERIC/POSITION/RICH_TEXT custom field still shows the `123` icon in the picker.** The diff doesn't map these 5 types, so the exact UX confusion the issue targets persists for them (numbers icon on a non-numeric field). Bounded: these are uncommon custom-field types, and it's no worse than pre-fix. Captured as LOW #1.
2. **Picker vs settings-form icon disagreement for the 5 unmapped types.** A user creating a POSITION field via the settings form sees `IconUsers`; the same field in the record-list column header now shows `Icon123` (still). Inconsistent across surfaces, but pre-existing and out of plan scope. Captured as LOW #1/#2.
3. **Future enum addition silently inherits `Icon123` in the picker.** Because the map is `Partial<Record<...>>` (no exhaustiveness), adding a new `FieldMetadataType` compiles cleanly and the new type falls to `Icon123` with no warning — the same silent-default class this fix set out to reduce. Bounded and documented (plan failure mode 2). Captured as LOW #2's resolution.

None of the three are new *correctness regressions* introduced by the diff — each is a bounded, pre-existing-or-documented gap. No CRITICAL/HIGH.

## Recommendations to supervisor

- Block commit: no
- File new issues: 0 (both LOWs are foot-gun → backlog, not issue-worthy on their own)
- Annotate to plan: 2 (the two foot-gun LOWs → `packages/twenty-front/plans/low-backlog.md` Queued table)
- Confidence in this audit: high — all gates run and green, every icon name independently verified against the runtime registry, callers and sibling tests checked, tests confirmed substantive. The only findings are documented out-of-scope foot-guns.
