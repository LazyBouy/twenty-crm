# Plan: Infer a type-appropriate default icon instead of always Icon123

> Issue(s): #25
> Package: packages/twenty-front
> Severity: low
> Worst-case bug class if deferred: Imagined-because-plausible — the fallback `'Icon123'` (a numbers icon) is visually misleading for non-numeric field types (DATE, TEXT, SELECT, BOOLEAN, RELATION, etc.) and has no mechanical consequence beyond UX confusion. Deferral does not break any invariant; it just perpetuates the misleading default.
> Created: 2026-06-27
> Audit round 1: clean — see issue-25-infer-type-appropriate-default-icon-for-icon-less-fields-audit-round-1.md (0 critical/high/medium; 2 foot-gun LOWs → packages/twenty-front/plans/low-backlog.md). Retrospective on disk.

## Problem statement

When a custom field is created without an explicit `icon` value, `formatFieldMetadataItemAsFieldDefinition` at `packages/twenty-front/src/modules/object-metadata/utils/formatFieldMetadataItemAsFieldDefinition.ts:62` falls back to the string `'Icon123'` (the numbers icon) regardless of the field's `type`. This causes DATE_TIME, TEXT, SELECT, BOOLEAN, RELATION, and other non-numeric fields to appear with a numbers icon in the field/column/filter pickers — actively misleading users (e.g. a DATE_TIME field reads as a number field).

An authoritative type-to-icon mapping already exists in the codebase: `DEFAULT_ICONS_BY_FIELD_TYPE` at `packages/twenty-front/src/pages/settings/data-model/constants/DefaultIconsByFieldType.ts` (29 entries, all current `FieldMetadataType` values covered). The settings new-field form already uses this constant (`SettingsObjectNewFieldConfigure.tsx:72`). The fix is to make `formatFieldMetadataItemAsFieldDefinition` consult the same source of truth instead of hard-coding `'Icon123'`.

## Reproduction

n/a — the bug is cosmetic and consistently reproducible by inspecting any custom field created without an explicit icon in the Twenty UI. No specific stack state is needed.

Steps to observe (after standing up a local Twenty stack):

1. Via the Twenty MCP or settings UI, create a custom SELECT field on any object without specifying an `icon` parameter.
2. Navigate to the object's record list.
3. Observe the column/field header — it shows the numbers (123) icon instead of a tag/list icon.
4. Compare with the same field created via the settings UI new-field form — it shows `IconTag` (SELECT default per `DEFAULT_ICONS_BY_FIELD_TYPE`).

## Root cause hypothesis

`packages/twenty-front/src/modules/object-metadata/utils/formatFieldMetadataItemAsFieldDefinition.ts:62`:

```typescript
iconName: field.icon ?? 'Icon123',
```

The fallback `'Icon123'` is a hard-coded constant that ignores `field.type`. The correct fallback is `DEFAULT_ICONS_BY_FIELD_TYPE[field.type]`, which returns the type-appropriate icon name or `undefined` for types not in the map (in which case `'Icon123'` remains the last-resort fallback).

The authoritative mapping lives at `packages/twenty-front/src/pages/settings/data-model/constants/DefaultIconsByFieldType.ts:3-29`. It covers all 22 `FieldMetadataType` enum values including ACTOR, NUMERIC, POSITION, RICH_TEXT, TS_VECTOR (all mapped to `'IconUsers'` — a generic placeholder). The settings new-field configure page already uses it correctly; the `formatFieldMetadataItemAsFieldDefinition` util does not.

One import-path consideration: `DefaultIconsByFieldType.ts` imports `FieldMetadataType` from `~/generated-metadata/graphql`, while `formatFieldMetadataItemAsFieldDefinition.ts` imports it from `twenty-shared/types`. Both are structurally identical enums with the same string values (confirmed by reading both files). The constant `DEFAULT_ICONS_BY_FIELD_TYPE` is typed `Record<FieldMetadataType, string>` against the generated-metadata type. The fix can either (a) import the constant directly and use it with the `field.type` value (which is a string at runtime — the Record lookup is a string-indexed lookup), or (b) extract the constant to a shared location. Option (a) is the minimal-diff approach; if TypeScript complains about the `FieldMetadataType` type mismatch, cast `field.type as string` as the lookup key.

## Proposed fix

**One file to modify: `packages/twenty-front/src/modules/object-metadata/utils/formatFieldMetadataItemAsFieldDefinition.ts`**

**One new file to create: `packages/twenty-front/src/modules/object-metadata/utils/getDefaultIconForFieldType.ts`**

Step 1 — Extract a thin util (named export, kebab-case file, no default export) to avoid a cross-module import from `settings/` into `object-metadata/`:

```typescript
// packages/twenty-front/src/modules/object-metadata/utils/getDefaultIconForFieldType.ts
import { FieldMetadataType } from 'twenty-shared/types';

// Maps each FieldMetadataType to its preferred icon name.
// Source of truth: aligned with DEFAULT_ICONS_BY_FIELD_TYPE in
// src/pages/settings/data-model/constants/DefaultIconsByFieldType.ts.
// Keep in sync when new FieldMetadataType values are added.
const FIELD_TYPE_ICON_MAP: Partial<Record<FieldMetadataType, string>> = {
  [FieldMetadataType.ADDRESS]: 'IconMap',
  [FieldMetadataType.BOOLEAN]: 'IconToggleLeft',
  [FieldMetadataType.CURRENCY]: 'IconMoneybag',
  [FieldMetadataType.DATE]: 'IconCalendarEvent',
  [FieldMetadataType.DATE_TIME]: 'IconCalendarClock',
  [FieldMetadataType.FILES]: 'IconFile',
  [FieldMetadataType.FULL_NAME]: 'IconUserCircle',
  [FieldMetadataType.MULTI_SELECT]: 'IconTags',
  [FieldMetadataType.NUMBER]: 'IconNumber9',
  [FieldMetadataType.RATING]: 'IconStar',
  [FieldMetadataType.RAW_JSON]: 'IconBraces',
  [FieldMetadataType.RELATION]: 'IconRelationOneToMany',
  [FieldMetadataType.MORPH_RELATION]: 'IconRelationOneToMany',
  [FieldMetadataType.SELECT]: 'IconTag',
  [FieldMetadataType.TEXT]: 'IconTypography',
  [FieldMetadataType.UUID]: 'IconId',
  [FieldMetadataType.ARRAY]: 'IconBracketsContain',
  [FieldMetadataType.EMAILS]: 'IconMail',
  [FieldMetadataType.LINKS]: 'IconWorld',
  [FieldMetadataType.PHONES]: 'IconPhone',
};

export const getDefaultIconForFieldType = (
  type: FieldMetadataType,
): string => {
  return FIELD_TYPE_ICON_MAP[type] ?? 'Icon123';
};
```

**Icon verification (required before baking into the map):** Every icon name in `FIELD_TYPE_ICON_MAP` must be confirmed to exist in the `twenty-ui/display` icon set. The implementer must run:

```bash
grep -r "export.*IconToggleLeft\|export.*IconMoneybag\|export.*IconCalendarEvent\|export.*IconCalendarClock\|export.*IconFile\b\|export.*IconUserCircle\|export.*IconTags\b\|export.*IconNumber9\|export.*IconStar\b\|export.*IconBraces\|export.*IconRelationOneToMany\|export.*IconTag\b\|export.*IconTypography\|export.*IconId\b\|export.*IconBracketsContain\|export.*IconMail\b\|export.*IconWorld\b\|export.*IconPhone\b\|export.*IconMap\b" packages/twenty-ui/src/
```

Any name that returns no export must be replaced with the closest available icon before shipping. The map above is aligned with `DefaultIconsByFieldType.ts` which is already used in production (new-field form) — so all names are expected to exist; verify to be certain.

Step 2 — Update `formatFieldMetadataItemAsFieldDefinition.ts:62`:

```typescript
import { getDefaultIconForFieldType } from '@/object-metadata/utils/getDefaultIconForFieldType';

// line 62:
iconName: field.icon ?? getDefaultIconForFieldType(field.type),
```

**Files to modify:**
- `packages/twenty-front/src/modules/object-metadata/utils/formatFieldMetadataItemAsFieldDefinition.ts` (line 62: change fallback; add import)

**Files to create:**
- `packages/twenty-front/src/modules/object-metadata/utils/getDefaultIconForFieldType.ts` (new util, named export only)

**Files NOT modified:**
- `packages/twenty-front/src/pages/settings/data-model/constants/DefaultIconsByFieldType.ts` — left as-is (duplicate is intentional to avoid cross-module dependency from object-metadata/ into settings/; keeping in sync is documented in the new util's comment)
- Any server-side file — see Out of scope.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] **Unit test — full type-to-icon mapping:**
  Create `packages/twenty-front/src/modules/object-metadata/utils/__tests__/getDefaultIconForFieldType.test.ts`:
  ```bash
  npx jest packages/twenty-front/src/modules/object-metadata/utils/__tests__/getDefaultIconForFieldType.test.ts --config=packages/twenty-front/jest.config.mjs
  ```
  The test must assert:
  - `getDefaultIconForFieldType(FieldMetadataType.DATE_TIME)` returns `'IconCalendarClock'`
  - `getDefaultIconForFieldType(FieldMetadataType.SELECT)` returns `'IconTag'`
  - `getDefaultIconForFieldType(FieldMetadataType.TEXT)` returns `'IconTypography'`
  - `getDefaultIconForFieldType(FieldMetadataType.BOOLEAN)` returns `'IconToggleLeft'`
  - `getDefaultIconForFieldType(FieldMetadataType.RELATION)` returns `'IconRelationOneToMany'`
  - `getDefaultIconForFieldType(FieldMetadataType.EMAILS)` returns `'IconMail'`
  - `getDefaultIconForFieldType(FieldMetadataType.PHONES)` returns `'IconPhone'`
  - `getDefaultIconForFieldType(FieldMetadataType.RATING)` returns `'IconStar'`
  - `getDefaultIconForFieldType(FieldMetadataType.LINKS)` returns `'IconWorld'`
  - `getDefaultIconForFieldType(FieldMetadataType.NUMBER)` returns `'IconNumber9'` (not Icon123 — numbers icon preserved for NUMBER type)
  - `getDefaultIconForFieldType(FieldMetadataType.NUMERIC)` returns `'Icon123'` (unmapped types fall back to Icon123)
  - `getDefaultIconForFieldType(FieldMetadataType.ACTOR)` returns `'Icon123'` (unmapped fallback)

- [ ] **Unit test — formatFieldMetadataItemAsFieldDefinition uses type-inferred icon when field.icon is null/undefined:**
  ```bash
  npx jest packages/twenty-front/src/modules/object-metadata/utils/__tests__/formatFieldMetadataItemAsFieldDefinition.test.ts --config=packages/twenty-front/jest.config.mjs
  ```
  The test must assert:
  - A mock DATE_TIME field with `icon: null` produces `iconName: 'IconCalendarClock'`
  - A mock SELECT field with `icon: undefined` produces `iconName: 'IconTag'`
  - A mock TEXT field with `icon: 'IconCustom'` (explicit icon) produces `iconName: 'IconCustom'` (no override)

- [ ] **Icon names exist in twenty-ui (mechanical grep before coding):**
  ```bash
  grep -rn "export.*IconToggleLeft\|export.*IconCalendarEvent\|export.*IconCalendarClock\|export.*IconTag\b\|export.*IconTypography\|export.*IconRelationOneToMany\|export.*IconMail\b\|export.*IconPhone\b\|export.*IconStar\b\|export.*IconWorld\b" packages/twenty-ui/src/ | wc -l
  ```
  Must return >= 9 (one match per distinct icon name). Any name that returns 0 must be replaced before the PR is opened.

- [ ] **TypeScript typecheck passes:**
  ```bash
  npx nx typecheck twenty-front
  ```
  Must pass with zero new errors.

- [ ] **Lint diff passes:**
  ```bash
  npx nx lint:diff-with-main twenty-front
  ```
  Must pass with zero new errors.

## Failure modes named (R3: adversarial pre-mortem)

1. **`FieldMetadataType` mismatch between `twenty-shared/types` and `~/generated-metadata/graphql`:** The new util uses the `twenty-shared/types` enum (same as the file being edited). `DEFAULT_ICONS_BY_FIELD_TYPE` uses the generated-metadata enum. Both enums have the same string values (confirmed: both define e.g. `SELECT = 'SELECT'`). TypeScript may flag a type incompatibility if the two enums are treated as distinct nominal types. Mitigation: the new util declares its map as `Partial<Record<FieldMetadataType, string>>` using the `twenty-shared/types` import, so there is no cross-enum comparison in user code. The generated-metadata enum is only used in `DefaultIconsByFieldType.ts`, which this fix does not modify.

2. **A new `FieldMetadataType` enum value is added in the future without updating `FIELD_TYPE_ICON_MAP`:** The map is `Partial<Record<...>>` so missing entries return `undefined` and fall back to `'Icon123'` — which is the current behavior for all types. No crash, but the new type will show 123 icon. Mitigation: the util's code comment documents that it must be kept in sync with `DefaultIconsByFieldType.ts`; a future audit can catch the drift. The `Partial<Record<>>` type (rather than `Record<>`) is intentional to make the fall-through explicit without requiring exhaustiveness.

3. **`DEFAULT_ICONS_BY_FIELD_TYPE` in settings and `FIELD_TYPE_ICON_MAP` in the new util drift apart over time:** Two separate copies of the same mapping exist (one in settings/, one in object-metadata/). A future contributor may update one but not the other. Mitigation: documented in the util's comment. The supervisor may choose to refactor this into a single shared constant (e.g. in `twenty-shared/`) as a follow-up; that is explicitly out of scope here to keep the diff minimal and the risk surface contained to one file.

## Out of scope

- **Server-side relation icon defaults (`generate-morph-or-relation-flat-field-metadata-pair.util.ts:141`, `compute-flat-field-to-update-from-morph-relation-update-payload.util.ts:110`):** Both fall back to `'Icon123'`. Issue #25 is specifically about the UI field picker render (the `formatFieldMetadataItemAsFieldDefinition` fallback). Server-side defaults set the `icon` stored in the database; if the caller passes `icon: undefined` to the server's field creation API, the stored icon will be null, and the UI will then use the new `getDefaultIconForFieldType` fallback. The server-side defaults are a separate concern. Deferring server-side changes. Worst case if wrong: fields created via the server's API without an icon will have `null` stored as icon, and the UI will correctly show the type-inferred icon from this fix — which is actually the desired behavior. No regression.
- **Consolidating `DEFAULT_ICONS_BY_FIELD_TYPE` (settings/) and `FIELD_TYPE_ICON_MAP` (new util) into a single shared location:** Refactoring into `twenty-shared` would require a build step change. Deferred. Worst case if wrong: the two copies drift — acknowledged in failure mode 3.
- **`SettingsObjectNewFieldConfigure.tsx:38` fallback `DEFAULT_ICON_FOR_NEW_FIELD = 'IconUsers'`:** This fires when the fieldType from the URL param is not in `DEFAULT_ICONS_BY_FIELD_TYPE`. Not affected by this fix. Out of scope.

## References

- packages/twenty-front/src/modules/object-metadata/utils/formatFieldMetadataItemAsFieldDefinition.ts:62 (the fallback being fixed)
- packages/twenty-front/src/pages/settings/data-model/constants/DefaultIconsByFieldType.ts (authoritative mapping — used by settings new-field form)
- packages/twenty-front/src/pages/settings/data-model/new-field/SettingsObjectNewFieldConfigure.tsx:31-72 (existing consumer of DEFAULT_ICONS_BY_FIELD_TYPE)
- packages/twenty-front/src/modules/object-metadata/utils/getIconForObjectType.ts (structural reference for icon util pattern in object-metadata/)
- packages/twenty-server/src/engine/metadata-modules/flat-field-metadata/utils/generate-morph-or-relation-flat-field-metadata-pair.util.ts:141 (server-side Icon123 — out of scope, noted)
- packages/twenty-server/src/engine/metadata-modules/flat-field-metadata/utils/compute-flat-field-to-update-from-morph-relation-update-payload.util.ts:110 (server-side Icon123 — out of scope, noted)

## Implementation notes
> Implemented: 2026-06-28T00:00:00Z

### Files changed
```
packages/twenty-front/src/modules/object-metadata/utils/formatFieldMetadataItemAsFieldDefinition.ts  (modified)
packages/twenty-front/src/modules/object-metadata/utils/getDefaultIconForFieldType.ts  (created)
packages/twenty-front/src/modules/object-metadata/utils/__tests__/getDefaultIconForFieldType.test.ts  (created)
packages/twenty-front/src/modules/object-metadata/utils/__tests__/formatFieldMetadataItemAsFieldDefinition.test.ts  (created)
```

### Diff stat
```
packages/.../utils/formatFieldMetadataItemAsFieldDefinition.ts  | 3 ++-
1 file changed, 2 insertions(+), 1 deletion(-)
(3 new files created — untracked, not in git diff --stat)
```

### Icon names verified in packages/twenty-ui/src/
All 20 icon names in `FIELD_TYPE_ICON_MAP` were verified to exist in `packages/twenty-ui/src/display/icon/providers/internal/AllIcons.ts` (each with count=2, consistent with the dual-registration pattern in that file):

- IconMap (ADDRESS)
- IconToggleLeft (BOOLEAN)
- IconMoneybag (CURRENCY)
- IconCalendarEvent (DATE)
- IconCalendarClock (DATE_TIME)
- IconFile (FILES)
- IconUserCircle (FULL_NAME)
- IconTags (MULTI_SELECT)
- IconNumber9 (NUMBER)
- IconStar (RATING)
- IconBraces (RAW_JSON)
- IconRelationOneToMany (RELATION, MORPH_RELATION)
- IconTag (SELECT)
- IconTypography (TEXT)
- IconId (UUID)
- IconBracketsContain (ARRAY)
- IconMail (EMAILS)
- IconWorld (LINKS)
- IconPhone (PHONES)

The plan's test plan grep (`export.*IconToggleLeft|export.*IconCalendarEvent|...` against packages/twenty-ui/src/) returns 10, which is >=9 — the grep hits `IllustrationIcon*` exports (illustration variants of the same names), all valid.

### Test results

**Command 1: getDefaultIconForFieldType unit tests**
```
npx jest packages/twenty-front/src/modules/object-metadata/utils/__tests__/getDefaultIconForFieldType.test.ts --config=packages/twenty-front/jest.config.mjs
```
PASS — 12 tests passed:
- returns IconCalendarClock for DATE_TIME
- returns IconTag for SELECT
- returns IconTypography for TEXT
- returns IconToggleLeft for BOOLEAN
- returns IconRelationOneToMany for RELATION
- returns IconMail for EMAILS
- returns IconPhone for PHONES
- returns IconStar for RATING
- returns IconWorld for LINKS
- returns IconNumber9 for NUMBER (not Icon123)
- returns Icon123 fallback for NUMERIC (unmapped type)
- returns Icon123 fallback for ACTOR (unmapped type)

**Command 2: formatFieldMetadataItemAsFieldDefinition unit tests**
```
npx jest packages/twenty-front/src/modules/object-metadata/utils/__tests__/formatFieldMetadataItemAsFieldDefinition.test.ts --config=packages/twenty-front/jest.config.mjs
```
PASS — 3 tests passed:
- uses type-inferred icon when field.icon is null for DATE_TIME → IconCalendarClock
- uses type-inferred icon when field.icon is undefined for SELECT → IconTag
- preserves explicit icon and does not override it → IconCustom

**Command 3: Icon-existence grep**
```
grep -rn "export.*IconToggleLeft|...|export.*IconWorld\b" packages/twenty-ui/src/ | wc -l
```
PASS — result: 10 (>= 9 required)

**Command 4: TypeScript typecheck**
```
npx nx typecheck twenty-front
```
PASS — exit 0, zero errors

**Command 5: Lint diff with main**
```
npx nx lint:diff-with-main twenty-front
```
PASS — exit 0 (reports "No changed files" because lint:diff-with-main uses git diff main...HEAD against committed files; new files are untracked/unstaged). Lint verified manually by running oxlint and prettier directly against the 4 changed files:
- `npx oxlint --type-aware -c .oxlintrc.json <files>` → Found 0 warnings and 0 errors.
- `npx prettier --check <files>` → All matched files use Prettier code style!

Three prettier violations were found and fixed manually (no auto-fixer used):
1. `getDefaultIconForFieldType.ts`: function signature collapsed from multi-line to single-line
2. `getDefaultIconForFieldType.test.ts`: last `toBe(...)` call collapsed to single line
3. `formatFieldMetadataItemAsFieldDefinition.test.ts`: `jest.mock(...)` call and `buildField` signature collapsed to single lines

### Surprises
1. The plan's `lint:diff-with-main` gate reports "No changed files" for untracked/unstaged files because it uses `git diff --name-only --relative --diff-filter=d main...HEAD -- src/`. This is expected behavior; lint was validated by direct oxlint + prettier invocations on the actual files as a substitute, both clean.
2. Prettier wanted three formatting changes from what was written. All three were multi-line-to-single-line collapses for short function signatures and one `jest.mock(...)` call. Fixed manually.
3. The icon grep in the test plan hits `IllustrationIcon*` variants (e.g. `IllustrationIconCalendarEvent`), not the plain `Icon*` names directly. The plain icon names are verified through `AllIcons.ts` which is the actual runtime registry. Both sets confirm icon existence.
