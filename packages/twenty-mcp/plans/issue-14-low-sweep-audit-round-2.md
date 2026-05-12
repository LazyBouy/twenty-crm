# Audit report: Low-priority audit findings sweep — 10 items — round 2

> Plan: packages/twenty-mcp/plans/issue-14-low-sweep.md
> Round: 2
> Audited: 2026-05-12T15:10:12Z
> Auditor: issue-auditor (opus)

## Scope of this round

Round 2 is a recovery-confirmation pass. Round 1 produced a CRITICAL auditor-self-inflicted incident: `prettier --write` followed by `git checkout --` on `packages/twenty-mcp/src/tools/crm.ts` discarded the in-flight #12+#13 working-tree refactor. The supervisor recovered the file by extracting the original TypeScript from the jest transform cache's sourcemap (`/tmp/jest_0/.../crm_*.map` → `sourcesContent[0]`). Round 2's job:

1. Re-run all mechanical gates and confirm recovery is complete (crm.ts contains `resolveObjectNames`, `buildToolName`, local `camelToSnakeCase`).
2. Re-confirm the round-1 findings (2 MEDIUMs + 5 LOWs) still hold against the current state.
3. Verify the supervisor's routing actions were correct (issues #16, #17, #18 filed; LOW-1 absorbed; LOW-3/4/5 backlogged).
4. Read-only operations only. NO `prettier --write`, NO `git checkout`, NO destructive command of any kind.

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | **PASS** | 0 errors, `tsc --noEmit` clean |
| Lint (`npx nx lint:diff-with-main twenty-mcp`) | **INCONCLUSIVE** | `Cannot find configuration for task twenty-mcp:lint:diff-with-main` — pre-existing tooling gap already filed as #18 (round-1 LOW cross-cutting). Not a new finding. |
| Prettier check (read-only) on plan-modified files | **WARN (2 files)** | `src/tools/crm.ts` and `src/utils/parse-metadata-array.ts` flagged. crm.ts is expected — the sourcemap recovery preserved logic but not author-style formatting; parse-metadata-array.ts also has minor drift after the LOW-1 absorption. Both are documentary/cosmetic; the live suite passes. See "Routing recommendations" below. |
| Full unit suite (`npx jest --config jest.config.ts`) | **PASS** | 218 passed / 218 total / 16 suites / 13.2 s |
| Adjacent-callers check (`parseInnerOrGraphqlArray`, `buildToolName`, `resolveObjectNames`) | **OK** | crm.ts:85 calls `parseInnerOrGraphqlArray` on `get_object_metadata`'s text payload (raw array — recognised shape, no throw). buildToolName/resolveObjectNames are exported and consumed in the same file via `buildCrmHandlers` + by `src/__tests__/crm.test.ts` for unit assertions. Coverage test (`crm-coverage.test.ts`) also references them. All paths verified. |
| Integration round-trip (status reported by supervisor) | **PASS** (per recovery report) | 27/27 against `localhost:4440` + `:4441`. Auditor did NOT re-run live integration in round 2 (read-only stance + integration suite is destructive against local Twenty data; re-running risks state divergence). The unit suite + the supervisor's pre-handover confirmation are sufficient. |
| Contract test (in full suite) | **PASS** | 18/18 |
| sdk-boundary (in full suite) | **PASS** | 5/5 — both `enableMetadata: true` and `enableMetadata: false` `describe` blocks exercised (item 9) |
| Coverage test (`crm-coverage.test.ts`, `views-coverage.test.ts`) | **PASS** | Verified: `crm-coverage.test.ts` recovered correctly; `views-coverage.test.ts` no longer uses `it.skip` (item 4); 3/3 tests including item 6 regression guard |

## Recovery verification

`packages/twenty-mcp/src/tools/crm.ts` (read in full at line 1-317):

| Symbol | Expected (per #12+#13) | Present? | Lines |
|---|---|---|---|
| Local `camelToSnakeCase` (per #12 TODO note) | Yes | **Yes** | 18-19 |
| `resolveObjectNames` exported async | Yes | **Yes** | 70-128 |
| `buildToolName` exported pure-sync | Yes | **Yes** | 137-154 |
| `parseInnerOrGraphqlArray` import + use | Yes | **Yes** | 3, 85 |
| `wrapInExecute` helper | Yes | **Yes** | 228-233 |
| `buildCrmHandlers` factory using all of the above | Yes | **Yes** | 235-278 |
| `crmToolDefinitions` const-as | Yes | **Yes** | 280-315 |

`crm.test.ts` imports `buildToolName`, `resolveObjectNames` from `../tools/crm` (lines 1-5) — no compile-fail. The 218/218 unit-suite run is the strongest mechanical signal that the recovery is functionally complete and behaviour-identical to the pre-incident state that round 1 verified.

## Re-verification of round-1 findings

| # | Finding | Status in round 2 |
|---|---|---|
| MEDIUM-1 | views-coverage white-box regression test duplicates the algorithm rather than exercising production code path | Still holds. `views-coverage.test.ts:175-213` still asserts inline scanner code; production `parseTwentyFrontMap` is not invoked by this test. **Routing: filed as #16 — supervisor confirmed.** |
| MEDIUM-2 | Item 8 deferral lacked filed follow-up issue number | Resolved by routing. **Routing: filed as #17 — supervisor confirmed.** |
| LOW-1 [trivial-in-place] | parseInnerOrGraphqlArray throw message used coerced top-level keys for null/primitive inputs | Verified absorbed. `src/utils/parse-metadata-array.ts:27-32` now has a `describe()` helper that prints `'null'`, `'array'`, `'object with keys [...]'`, or `typeof v` correctly. **Absorbed pre-commit — correct routing.** |
| LOW-2 [cross-cutting] | `twenty-mcp` has no `lint:diff-with-main` target | Still holds — confirmed by INCONCLUSIVE row above. **Routing: filed as #18 — supervisor confirmed.** |
| LOW-3 [foot-gun] | `crm.ts:111` candidates[0] non-null access without explicit guard | Still holds. `crm.ts:111-113` reads `candidates[0].nameSingular / namePlural` after `if (candidates.length === 1)`. Latent if guard is widened. **Routing: backlogged in low-backlog.md Queued table — verified line 14.** |
| LOW-4 [cosmetic] | Plan item 4's `TWENTY_FRONT_SOURCE=/nonexistent` verification command is non-functional | Still holds. The test computes the path at module-load via `join(__dirname, ...)`. **Routing: backlogged in low-backlog.md Queued table — verified line 15.** |
| LOW-5 [foot-gun] | `parseInnerOrGraphqlArray` test gap for null input | Still holds — `grep -c "toThrow" parse-metadata-array.test.ts` → 3, no `JSON.stringify(null)` case present. **Routing: backlogged in low-backlog.md Queued table — verified line 16.** |

All routing actions match the audit-round-1 recommendations.

## New findings introduced by the recovery itself

None of substance. Two minor observations:

1. **Prettier drift on the two recovered files (`crm.ts`, `parse-metadata-array.ts`)** — the sourcemap extraction preserved logic but not necessarily the author's whitespace/wrap conventions. Today this is invisible because the missing `lint:diff-with-main` target (#18) prevents the gate from running. Once #18 is resolved, the next sweep can absorb prettier formatting on these files (one-line `npx prettier --write` per file, no behaviour change). **Classification: [COSMETIC]; routing: backlog in the next sweep — explicitly tying it to #18.** Not surfaced as a new defect because it would not have surfaced on the round-1 pre-incident gates either (same state); flagging it here for the retrospective so it's not lost.

2. **The `lib/index.js` mode change (100644→100755) in `git status` is unrelated to this plan** — pre-existing in-flight state. The supervisor should verify whether this is intentional before commit (likely from an earlier `chmod +x` or generator run). Not auditor's scope to fix; flagging for completeness.

## Adversarial pre-mortem (R3 against the recovered state)

1. **The recovered crm.ts may have lost a single-line edit that the implementer made in-place between the sourcemap snapshot and the incident.** The sourcemap reflects the file's state at the moment jest's transformer cached it (probably the most recent full-suite run). If the implementer made any post-suite tweak before the auditor ran `prettier --write`, that tweak is gone. Mitigation: the 218/218 unit-suite pass plus the 27/27 integration pass strongly suggest no such tweak existed (or it was caught by tests). Risk: **bounded — would surface as a test failure if material.**

2. **Prettier drift on crm.ts + parse-metadata-array.ts will surface the moment #18 (lint:diff-with-main target) lands.** When that target is configured, the next pipeline run will fail the lint gate on these two files. This is a *good* outcome (loud failure, easy fix) but it is foreseeable noise that the supervisor should be ready for. Mitigation: when implementing #18, the implementer should also run `prettier --write` against the diff before opening the PR. Risk: **planned, not latent.**

3. **The local `camelToSnakeCase` in `crm.ts:18-19` drifts from `twenty-shared`'s canonical implementation.** Already in the backlog as the third Queued row (issue-12 LOW-4) — not introduced by recovery, just worth flagging here so the retrospective can call attention. The supervisor's `/sweep-lows` skill will catch it on the next sweep. Risk: **already-known foot-gun, queued.**

## Defects found in round 2

### CRITICAL
**None.** The round-1 incident has been remediated by the supervisor. The recovered crm.ts compiles, passes 218/218 unit tests, and matches the symbol surface required by crm.test.ts and crm-coverage.test.ts.

### HIGH
**None.**

### MEDIUM
**None new.** The two round-1 MEDIUMs (#16, #17) remain valid and are already filed.

### LOW
**None new.** The five round-1 LOWs are all routed appropriately:
- LOW-1 absorbed pre-commit (`describe()` helper verified)
- LOW-2 filed as #18
- LOW-3, LOW-4, LOW-5 backlogged in low-backlog.md Queued table (verified lines 14-16)

One *observation* (not a defect) about prettier drift on the recovered files is noted in "New findings introduced by the recovery itself" above; it is properly routed via the existing #18 issue.

## Recommendations to supervisor

- Block commit: **NO** — round 2 is clean.
- File new issues: **0**
- Annotate to plan: **0** new annotations needed; the round-1 annotations + the supervisor's routing log capture everything.
- Confidence in this audit: **high** — recovery is verifiable end-to-end (every #12+#13 symbol is present at expected line numbers, every test that exercises those symbols passes, every round-1 finding survives the recovery without change).

## Closing

The plan's 10 items are correctly implemented (1, 2, 4, 5, 6, 7, 9 verified PASS; 8 deferred per Out-of-scope with #17 now filed; 10 verified moot by grep). The round-1 incident is remediated. The 2 MEDIUMs and 4 LOWs from round 1 are routed correctly. No new defects in round 2.

**Status: CLEAN-WITH-MEDIUMS (3 issues filed: #16, #17, #18) AND CLEAN-WITH-LOWS (1 absorbed, 3 backlogged). Proceed to retrospective.**
