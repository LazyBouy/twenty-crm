# Audit report: create_view_filter / update_view_filter — SELECT IS/IS_NOT value must be array — round 1

> Plan: packages/twenty-mcp/plans/issue-10-create-update-view-filter-select-is-isnot-value-must-be-array.md
> Round: 1
> Audited: 2026-06-28T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | `npx tsc --noEmit` clean, exit 0. |
| Lint (prettier `--check` on all 4 changed files) | PASS | "All matched files use Prettier code style!" exit 0. NOTE: twenty-mcp's `lint`/`lint:diff-with-main` targets are prettier-only (no eslint/oxlint target exists — confirmed via project.json targets list: build/start/dev/clean/test/lint/lint:diff-with-main/typecheck). The prettier check therefore IS the full lint gate. Validated directly on uncommitted files per instructions. |
| Full unit suite (`npx jest --config jest.config.ts`) | PASS | 17 suites, 230 tests, ~13.5s. |
| Coverage + contract + views-coverage tests | PASS | 3 suites, 37 tests — no schema drift from the describe-text change. |
| Adjacent-callers check | OK | `assertOperandCompatible` (2 callers: views.ts create/update handlers + metadata.ts apply_plan), `coerceSelectIsValue` (2 call sites in views.ts), `effectiveArgs` (const→let in metadata.ts). All inspected — see below. |

## Symmetry / three-site coercion verification (the headline probe)

The coercion IS applied symmetrically at all three required dispatch sites:

1. **`metadataCreateViewFilter`** (views.ts:466-474) — `coerceSelectIsValue(args.value, check.fieldType ?? '', args.operand)` after `check.valid`. Test: `views.test.ts:358` asserts `forwardedArgs.value` `toEqual(['TIER_A'])`. ✓
2. **`metadataUpdateViewFilter`** (views.ts:501-513) — coercion inside the `args.operand !== undefined` block, gated on `args.value !== undefined`. Test: `views.test.ts:423` (IS_NOT string→array) asserts forwarded value `['TIER_B']`. ✓
3. **apply_plan CREATE/UPDATE_VIEW_FILTER** (metadata.ts:701-712) — coercion inside the existing `(CREATE_VIEW_FILTER || UPDATE_VIEW_FILTER) && typeof operand === 'string'` guard, after `check.valid`. Test: `metadata.test.ts:1108` asserts forwarded value `['TIER_A']`. ✓

No site was missed — this fix avoids the issue-#3 sibling bug class (asymmetric Layer 1 / Layer 2).

## Adversarial probes (all clean)

- **Double-wrap:** guard is `typeof value === 'string'`; an array `['TIER_A']` is not a string → passes through unchanged. Verified by `views.test.ts:379` and `metadata.test.ts:1139` (both assert no `[['TIER_A']]`). ✓
- **operand-undefined (update direct handler):** coercion lives entirely inside `if (args.operand !== undefined)`; the no-operand branch returns `stripFieldMetadataIdFromUpdateArgs(args)` unchanged with no field-metadata lookup. Verified by `views.test.ts:243` (`value-only passes through`, asserts no `get_field_metadata` call). ✓
- **operand-undefined (apply_plan):** coercion is inside `typeof effectiveArgs.operand === 'string'`; never fires when operand absent. ✓
- **Non-SELECT TEXT CONTAINS:** `fieldType === 'SELECT'` fails for TEXT → value forwarded unchanged. Verified by `views.test.ts:400` (asserts `forwardedArgs.value` `toBe('foo')`). ✓
- **MULTI_SELECT:** SELECT-only helper does NOT coerce MULTI_SELECT — intended per plan's "Out of scope" (deferred follow-up). Pre-existing behaviour, not made worse. (No test asserts MULTI_SELECT passthrough; not blocking — pre-existing, documented.) ✓
- **unknownType path:** `assertOperandCompatible` returns `{ valid: true, unknownType: true }` with no `fieldType` (views.ts:184) → `check.fieldType` is `undefined` → `=== 'SELECT'` is false → original value passes through. ✓
- **`args.operand!` non-null assertion (views.ts:506):** safe — inside `if (args.operand !== undefined)`. ✓
- **`effectiveArgs` const→let (metadata.ts:656):** changed correctly; only re-assigned by the spread-replace at line 708. No other writer. ✓
- **describe-text change / schema shape:** only `.describe()` text changed on both value schemas (views.ts:351, 374); the union type is unchanged. Coverage/contract/views-coverage tests all green — no drift. ✓
- **Test substance (non-vacuous):** every new test asserts the FORWARDED value shape via `toolsCall.mock.calls` → `arguments.value`, not merely that the call succeeded. Not `Tested-because-mock-passes`. ✓

## Defects found

### CRITICAL — none

### HIGH — none

### MEDIUM — none

### LOW

1. **Stale SELECT value rule in `metadata_create_view_filter` tool description** [TRIVIAL-IN-PLACE] (packages/twenty-mcp/src/tools/views.ts:598)
   - What: The plan's Part A identified `"IS/IS_NOT on SELECT: option value (UPPER_SNAKE_CASE)"` as the misleading text and corrected it on BOTH `value` schema `.describe()` calls (views.ts:351, 374). But the SAME wrong string survives in a THIRD location: the tool-level `description` field of `metadata_create_view_filter` (views.ts:598) still reads `"IS/IS_NOT on SELECT: option value (UPPER_SNAKE_CASE)."`. This is the tool description an LLM reads first, before the per-field describe text — so it is arguably the MORE load-bearing of the two strings.
   - Why low: The coercion (Part B) defensively wraps a plain SELECT IS/IS_NOT string to an array at all three dispatch sites, so even an LLM that follows this stale text produces a correct array row — no UI crash, no broken DB row. There is therefore no correctness regression; the defect is contract-text inaccuracy only. No existing test asserts this string, so the edit changes no test outcome.
   - Subcategory rationale: It is a specific, mechanical, single-string in-place edit with no behaviour change — `trivial-in-place`, not `cosmetic`, because it is a real contract inaccuracy that the plan explicitly set out to eliminate (L6: "Tool descriptions ARE the contract for LLMs. Audit them when schemas change."), and the plan's "Part A" scope was *fixing the misleading SELECT-string*; this occurrence was simply missed. Escalated above `cosmetic` per the tie-break rule.
   - Suggested action: In views.ts:598, change `IS/IS_NOT on SELECT: option value (UPPER_SNAKE_CASE).` to `IS/IS_NOT on SELECT: array of option values e.g. ["TIER_A"] — NOT a plain string.` (matching the corrected schema describe text at views.ts:351). One Edit; re-run `npx jest --config jest.config.ts src/__tests__/coverage.test.ts src/__tests__/contract.test.ts` (both pass — neither asserts the string, so no test churn) and `npx prettier --check`. Estimated absorb time: 3min.

## Adversarial pre-mortem (R3 against the diff)

1. **LLM mis-guidance from the stale description (views.ts:598).** In the next hour, an agent reading `metadata_create_view_filter`'s description sees "IS/IS_NOT on SELECT: option value (UPPER_SNAKE_CASE)" and emits `value: "TIER_A"`. The coercion saves the row, but the description is self-contradictory with the per-field describe ("array of option values … NOT a plain string") two screens up — an agent reasoning carefully about the contradiction could waste a turn. Bounded by the coercion; captured as LOW-1.
2. **MULTI_SELECT IS string still produces a broken row.** A caller who passes `value: "TIER_A"` for a MULTI_SELECT IS filter is NOT coerced (helper is SELECT-only) and lands a broken string row → same UI crash this fix set out to prevent, for the sibling field type. This is explicitly out-of-scope per the plan and flagged for a follow-up issue. Not introduced by the diff (pre-existing), but the diff's existence makes the SELECT-vs-MULTI_SELECT asymmetry sharper. Acceptable per plan; worth the follow-up issue the plan already names.
3. **`check.fieldType ?? ''` swallows the unknownType signal in the direct handlers.** In `metadataCreateViewFilter`/`metadataUpdateViewFilter`, `coerceSelectIsValue(args.value, check.fieldType ?? '', ...)` passes `''` when fieldType is undefined (unknownType path). `coerceSelectIsValue` then compares `'' === 'SELECT'` → false → passthrough, which is the intended fail-open behaviour. No defect — but if a future edit ever makes `coerceSelectIsValue` treat empty-string field type specially, the `?? ''` masks the "unknown type" distinction. Latent only; not actionable now.

## Recommendations to supervisor

- Block commit: no
- File new issues: 0 (the MULTI_SELECT follow-up is already named in the plan's "Out of scope"; supervisor may file it at discretion — not a defect in THIS diff)
- Annotate to plan / route LOW: 1 (LOW-1, trivial-in-place → absorb pre-commit per routing policy)
- Confidence in this audit: high — all 4 files read in full, all three coercion sites + every adversarial probe verified against tests, full suite + coverage + contract green, prettier (the actual full lint gate for this package) clean on all 4 files.
