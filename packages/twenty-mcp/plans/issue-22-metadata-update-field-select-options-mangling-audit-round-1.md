# Audit report: metadata_update_field SELECT options mangling (#22) — round 1

> Plan: packages/twenty-mcp/plans/issue-22-metadata-update-field-select-options-mangling.md
> Round: 1
> Audited: 2026-06-27T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | `tsc --noEmit` clean, zero errors. |
| Lint (`npx nx lint:diff-with-main twenty-mcp`) | **FAIL** | Prettier `--check` failed on BOTH changed source files: `src/__tests__/integration/round-trip.test.ts` and `src/tools/metadata.ts`. "Code style issues found in 2 files." Gate exits non-zero. |
| Full unit suite (`jest --config jest.config.ts`) | PASS | 17 suites, 224 tests passed, ~13s. Includes coverage.test.ts (16) + contract.test.ts. |
| Coverage test | PASS | 16 tests; reads `inner-tool-schemas.json` (not the catalog). No wrapper→inner-tool contract drift. |
| Contract test | PASS | `update_field_metadata` classified for forbidden-top-level check; passes. |
| Adjacent-callers check | OK | Only caller of `metadataUpdateField` is `server.ts:155` (force-cast `args`, no `.parse()`); only consumers of `metadataUpdateFieldInputSchema` are the handler signature + `metadataToolDefinitions.metadata_update_field.inputSchema`. No apply_plan call site touches the direct handler. |

Note on the integration test (Command 5 in plan notes): NOT re-run by this auditor — it requires a live local docker-compose Twenty stack with destructive flags. Per the infrastructure prohibitions I do not bring the stack up. The plan's captured output shows 2 passed / 27 skipped; I take that at face value and audit the test *source* instead (see HIGH/MEDIUM below).

## Defects found

### CRITICAL — none.

### HIGH — blocks commit

1. **Lint gate is red: prettier formatting check fails on both changed source files** (`src/tools/metadata.ts`, `src/__tests__/integration/round-trip.test.ts`)
   - What: `npx nx lint:diff-with-main twenty-mcp` exits non-zero. Prettier `--check` reports "Code style issues found in 2 files." In `metadata.ts` the new handler block has object-property lines exceeding the 80-char print width (e.g. line 464 `message: 'metadata_update_field: options could not be parsed as JSON',` at 88 chars; line 465 at 122 chars; line 481 at 127 chars) that prettier reflows.
   - Why high: `lint:diff-with-main` is a required before-shipping mechanical gate (CLAUDE.md checklist). A red lint gate blocks commit by the package's own rules. The plan's "Test results" section reported typecheck-adjacent and jest gates but **never ran the lint gate** — this is exactly the "Audited-because-tests-passed" framing the package CLAUDE.md warns against (green jest ≠ green lint).
   - Evidence:
     ```
     Checking formatting...
     [warn] src/__tests__/integration/round-trip.test.ts
     [warn] src/tools/metadata.ts
     [warn] Code style issues found in 2 files. Run Prettier with --write to fix.
     ERROR: Prettier formatting check failed!
     ... twenty-mcp:lint:diff-with-main failed
     ```
   - Suggested fix: supervisor runs `npx nx lint:diff-with-main twenty-mcp --configuration=fix` (the auditor may not run `--write`/`--fix`), then re-runs the unit suite to confirm the reflow didn't change behaviour. Mechanical, ~1 min. This is the sole commit-blocker.

### MEDIUM — file as new GitHub issue

1. **MULTI_SELECT parity is asserted, never exercised — the plan's own R3 mitigation was dropped** (`src/__tests__/integration/round-trip.test.ts`, `src/tools/metadata.ts`)
   - What: The plan's Failure-mode #3 explicitly proposed "add a second live round-trip test that exercises MULTI_SELECT as well." No MULTI_SELECT test exists anywhere in the package (`grep -rn MULTI_SELECT src/` returns only descriptions/fixtures/views-operator-tables — zero test cases). The #22 integration test creates a `SELECT` field only.
   - Why medium (not low): The plan named this as the mitigation for a named failure mode and then did not implement it — a silent drop of a planned verifier (R4 violation). Mitigating factor that keeps it out of HIGH: the handler coercion is provably field-type-agnostic by reading — it branches only on `typeof options === 'string'` and `Array.isArray(options)`, never on field type — and Twenty's inner `update_field_metadata` schema types `options` as a single freeform field shared by SELECT and MULTI_SELECT (confirmed in `inner-tool-schemas.json:1651`). So the SELECT path and MULTI_SELECT path are identical at the proxy boundary. The residual, bounded risk is that Twenty's MULTI_SELECT *resolver* (not its schema) treats the options array differently at runtime — which the SELECT test cannot catch.
   - Draft issue title: `metadata_update_field: add a live MULTI_SELECT options round-trip test (issue #22 R3 mitigation dropped)`
   - Draft issue body: `The #22 fix coerces \`options\` for SELECT and MULTI_SELECT identically (handler is field-type-agnostic). The #22 plan's R3 failure-mode #3 proposed a MULTI_SELECT live round-trip test as the mitigation, but only a SELECT test shipped. Add a sibling \`describeIfDestructive\` block in round-trip.test.ts that creates a custom object with a MULTI_SELECT field and updates its options array, asserting no \"options.map is not a function\". Keeps parity claims mechanically verified per R4.`

### LOW — varied routing per subcategory

1. **`tools-catalog.json` carries 84 lines of workspace drift unrelated to #22, and the file is read by nothing** [COSMETIC] (`src/__tests__/fixtures/tools-catalog.json`)
   - What: The capture-script refresh added `create_campaign`, `create_outreach_participation`, `find_campaigns`, etc. — tools for `campaign`/`outreachParticipation` objects that exist in the local workspace now but didn't at the 2026-05-12 capture. `$count` 260→276. None of this relates to the #22 options fix. `grep -rln tools-catalog src/` returns zero hits — the file is written by `scripts/capture-inner-schemas.ts` and consumed by no test and no runtime code (discovery does not read it).
   - Why low: Zero test/runtime impact (dead fixture). Pure reviewer-surprise: a #22 commit carries an unrelated 84-line catalog churn.
   - Subcategory rationale: cosmetic, not foot-gun — there is no future change that turns this drift into a bug (nothing reads the file); it is noise in the diff, full stop.
   - Suggested action: backlog (cosmetic): `tools-catalog.json` is a dead fixture (written by capture script, read by nothing); either drop it from the #22 commit to keep the diff scoped, or stop committing it entirely. resolution: revert the `tools-catalog.json` hunk before commit (the #22 fix does not need it), OR file a one-line cleanup to delete the unused fixture.

2. **Wrapper's union array branch is stricter than Twenty's freeform `options` schema** [FOOT-GUN] (`src/tools/metadata.ts:149-165`)
   - What: The schema's array branch marks `value`, `label`, `color` as required strings. Twenty's inner `update_field_metadata` schema (`inner-tool-schemas.json:1651`) types `options` with no item shape and no required sub-fields — the `.map` error is a runtime array-vs-string mismatch, not a missing-`color` mismatch. Today this is advisory-only: `server.ts:155` force-casts `args` and never calls `.parse()`, so the stricter schema is advertised but not enforced.
   - Why low: No live impact today (schema not enforced at the boundary). The handler's runtime guard (Array.isArray) is the only enforcement and it is correct.
   - Subcategory rationale: foot-gun, not cross-cutting — it only bites if a *later* change enables SDK-side `.parse()` of incoming args (as `discovery` already does at server.ts:60); at that point a valid Twenty payload with a color-less option would be rejected at the boundary.
   - Suggested action: backlog (foot-gun): metadataUpdateField options array branch requires color/value/label that Twenty does not require; if SDK arg-validation is ever turned on for this tool it will over-reject valid payloads. resolution: when/if enabling `.parse()` at the metadata tool boundary, loosen the per-option fields to `.optional()` to match Twenty's freeform shape, or keep `.passthrough()` semantics.

3. **`inner-tool-schemas.json` change is timestamp-only — the fixture refresh added nothing this fix needed** [COSMETIC] (`src/__tests__/fixtures/inner-tool-schemas.json`)
   - What: The only content change in this file is the `$source` timestamp (`2026-05-12…` → `2026-06-27…`). No inner-tool schema changed. The #22 fix did not depend on any inner-schema refresh; running the capture script just re-stamped the file.
   - Why low: Harmless (coverage test stays green); purely a one-line timestamp churn.
   - Subcategory rationale: cosmetic — no behaviour, no future-triggered hazard.
   - Suggested action: backlog (cosmetic): inner-tool-schemas.json diff is a no-op timestamp bump; consider reverting the hunk to keep the #22 diff to the four files the fix actually needs. resolution: optionally `git checkout` the hunk pre-commit (supervisor's call — not the auditor's; auditor does not run checkout), or accept the timestamp churn.

## Adversarial pre-mortem (R3 against the diff)

1. **A green-jest commit ships with a red lint gate.** The implementer's notes report jest + integration + capture gates all green but never ran `lint:diff-with-main`. If the supervisor trusts the notes and commits, CI's prettier check fails on the very next push — the diff is not prettier-clean (HIGH-1). This is the concrete failure mode the diff introduces in the next hour.
2. **First real MULTI_SELECT options update surfaces a resolver-level shape difference that no test caught.** Because only SELECT is exercised live (MEDIUM-1), a MULTI_SELECT options update that Twenty's resolver treats differently (e.g. ordering, dedup, or an `id`-preservation quirk unique to multi-value fields) would reproduce a #22-class symptom with zero test signal — exactly the "Tested-because-mock-passes" class this package has shipped twice.
3. **A future reviewer bisects a campaign/outreach regression to this #22 commit.** The 84-line `tools-catalog.json` drift (LOW-1) means `git blame`/`git log -p` on those tool entries points at the #22 options-fix commit, sending a future debugger down a wrong path. Low-probability, but a real cost of committing unrelated capture drift.

## Recommendations to supervisor

- Block commit: **yes** — HIGH-1 (red lint gate) blocks. Mechanical to clear: run `lint:diff-with-main twenty-mcp --configuration=fix`, re-run the unit suite, re-audit (round 2) or supervisor self-verifies the reflow is behaviour-neutral.
- File new issues: 1 (MEDIUM-1 — MULTI_SELECT live test).
- Annotate / route lows: 3 (LOW-1 cosmetic backlog; LOW-2 foot-gun backlog; LOW-3 cosmetic backlog). Consider reverting the two fixture hunks (LOW-1, LOW-3) pre-commit to scope the diff — supervisor's call.
- Confidence in this audit: **high** for the static gates, handler logic (string→parse→Array.isArray guard verified correct: non-JSON string → isError; valid-JSON non-array → isError; spread override correct, no agent-key leakage since the schema has no wrapper-convenience keys), and the integration test's leak-safety (`fixtureObjectId` is set immediately after object creation and before the field-creation step that could throw, so `afterAll` always cleans up; jest runs `afterAll` even when an `it` assertion throws). **Medium** confidence only on the live integration result itself, which I did not re-run (no stack brought up per infra prohibitions) — I audited the test source, not a fresh live execution.

## Note: retrospective NOT written

Round 1 is a blocking pass (HIGH-1). Per the system prompt, the retrospective is written only on a clean pass (zero critical, zero high). It is intentionally absent.
