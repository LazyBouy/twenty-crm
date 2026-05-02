# Retrospective: Fix brittle test infrastructure from issue-3 implementation (#7, #8, #9)

> Issue(s): #7 (grouped: #8, #9)
> Plan: packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness.md
> Audit cycles: 3 (round 1 BLOCKED, round 2 BLOCKED, round 3 CLEAN)
> Commit: 2a462b91650db1acc22776bc4f54792522621275
> Written: 2026-05-03T00:35:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| `views.test.ts` 18 tests pass with the new fieldMetadataId-leak assertion | PASS — both the extended `value-only passes through` test and the dedicated `with operand does NOT forward fieldMetadataId` test pass on round-1, round-2, and round-3 implementations. |
| `metadata.test.ts` Layer-2 verifier (apply_plan UPDATE_VIEW_FILTER) asserts on outgoing args | Added in round 2 at `metadata.test.ts:822-852`; assertion correctly fires on the captured `wrapInExecute` `arguments` field. Round 1's plan didn't have this; round-1 HIGH-1 surfaced precisely because the apply_plan path was unfixed. Round 2 closed this with both the helper export AND the test. |
| `views-coverage.test.ts` parser handles arbitrary spread names generically | PASS — the regex-based generic spread resolver replaces the round-0 hardcoded `if` blocks. Round-1 LOW-2 noted the non-greedy `[\\s\\S]*?\\]` foot-gun but accepted (deferred to backlog as foot-gun). |
| Integration test discovers `DATE_TIME_FIELD_ID` dynamically | PASS — the `beforeAll` block self-discovers via `metadata_query({kind: 'fields', args: {limit: 200}})`. Round 1 implementation parsed the wrong shape (`{result?: [...]}.result ?? []`) — Surprise from the implementer's round-1 notes; fixed in round 2 by introducing `parseInnerOrGraphqlArray`, which round 3 then promoted to its own module. |
| Integration test's verification block is non-vacuous | PASS — round-3 live probe confirms a 1-row haystack with `operand: "IS"`; the `expect(leakedRows).toEqual([])` filter for `GREATER_THAN_OR_EQUAL` on the discovered DATE_TIME id returns `[]` from a non-empty array, genuinely verifying. Round 1's implementation had this assertion vacuously passing because the shape parse was wrong (HIGH-2). Round 2 fixed the shape parse but placed the helper unit test inside the integration-gated path (round-2 HIGH). Round 3 fixed the file-routing. |
| Failure mode #1 (parser fix introduces a false-negative for a known spread) | Did NOT surface. The regex `const\\s+${spreadName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]` correctly resolved `...emptyOperands` and `...relationOperands` against the live twenty-front source. Mitigation worked. |
| Failure mode #2 (paginated metadata_query and DATE_TIME field not on first page) | Did NOT surface. The local stock workspace returns 53 DATE_TIME fields in the first 200; the field is found. Captured as LOW-1 foot-gun for backlog. |
| Failure mode #3 (TypeScript `noUnusedLocals` rejects `_` destructure) | Did NOT surface. The `_` rename + tsconfig test-dir exclusion means the destructure compiles cleanly. |
| (NEW from round 1, not in plan) HIGH-1 parallel call site at apply_plan dispatch | Did surface in round 1 — the supervisor's prompt explicitly noted this concern; round 1 implementation did not address it; auditor blocked. Round 2 closed by exporting the helper and adding `argsTransform` to the dispatch entry. |
| (NEW from round 1, not in plan) HIGH-2 verification block silently no-ops | Did surface in round 1 — same shape-projection mistake the implementer's round-1 Surprise note already flagged for the `beforeAll`, but the same projection was repeated at the verification block 50 lines below. Round 2 closed by introducing `parseInnerOrGraphqlArray` and using it in BOTH places. |
| (NEW from round 2, not in plan) HIGH file-routing of helper unit test | Did surface in round 2 — the helper unit test was placed inside `src/__tests__/integration/round-trip.test.ts`, which jest's default config ignores via `testPathIgnorePatterns: /integration/`. The plan promised "always runs" but the file path silently shunted the test off the default path. Round 3 closed by extracting the helper to its own module and moving the unit tests to a non-integration path. |

## Audit journey

**Round 1 (BLOCKED — 0 critical, 2 high):**
- HIGH-1: `apply_plan` UPDATE_VIEW_FILTER path leaked `fieldMetadataId` to the inner tool — same #9 bug class, parallel call site at `metadata.ts:569-573`. The implementer's round-1 fix protected only the direct handler at `views.ts:368`; the dispatch entry had no `argsTransform`. Caught by adjacent-callers check.
- HIGH-2: Integration test's verification block parsed `metadata_query({kind: 'view_filters'})` as `{result?: [...]}` but the inner_tool transport returns a raw array — `(parsed.result ?? []).filter(...)` always produced `[]`, so `expect(leakedRows).toEqual([])` trivially passed regardless of whether a leak occurred. Caught by reading the implementer's own Surprise note about `beforeAll` shape and re-applying the same logic to the second metadata_query call site. Round-1 audit also identified 3 LOWs (LOW-1 fields-limit-200 foot-gun, LOW-2 views-coverage non-greedy regex foot-gun, LOW-3 misleading beforeAll error message trivial-in-place).

**Round 2 (BLOCKED — 0 critical, 1 high):**
- Round-2 plan: closed both round-1 HIGHs (HIGH-1 via shared `stripFieldMetadataIdFromUpdateArgs` helper used at both call sites; HIGH-2 via `parseInnerOrGraphqlArray` helper used at both `beforeAll` and verification block). Absorbed round-1 LOW-3 trivial-in-place (improved beforeAll error message to disambiguate stock-data-missing from shape-drift).
- Round-2 audit verified both round-1 HIGHs structurally closed (verified Layer-2 metadata.test.ts assertion fires on outgoing args; verified verification block returns a 1-row haystack on live stack). But surfaced a NEW HIGH: the standalone `parseInnerOrGraphqlArray — unit` describe block was placed inside `src/__tests__/integration/round-trip.test.ts`, which jest's default config excludes via `testPathIgnorePatterns: /integration/`. Mechanical reproducer: `npx jest src/__tests__/integration/round-trip.test.ts --testNamePattern='parseInnerOrGraphqlArray' --config jest.config.ts` returned `No tests found … testPathIgnorePatterns: /integration/`. The plan's test plan item #6 promised "always runs" but the file routing made that mechanically false. Round-2 audit also identified 4 LOWs (carried 1+2 forward + 2 new: LOW-3 helper returns [] silently for unrecognised shapes foot-gun; LOW-4 loose row typing cosmetic).

**Round 3 (CLEAN):**
- Round-3 plan: extracted `parseInnerOrGraphqlArray` to its own module at `packages/twenty-mcp/src/utils/parse-metadata-array.ts`; created unit-test file at `packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts` (NOT under `/integration/`); integration test now imports from the new module; round-3 plan added a "verifier-of-the-verifier" mechanical gate (test plan item #7) requiring the implementer to confirm the helper test runs on default invocation by checking test counts and grep-confirming the suite path appears in jest output.
- Round-3 audit: all 10 mechanical gates ran clean. Default `npx jest --config jest.config.ts` runs 169 tests including the 3 helper assertions; `INCLUDE_INTEGRATION=1` runs 169 + 15 skipped = 184; the gap is only the integration suite (NOT the helper tests). Live probe confirmed verification block produces a 1-row haystack — non-vacuous. Adjacent-callers check found no `update_view_filter` construction sites bypassing the helper, and no `.result ?? []` parsing pattern remaining in test/integration files for metadata arrays. The 4 round-2 LOWs are still present in the diff by design (round-3 plan explicitly deferred them to the LOW-routing pass). No new HIGHs introduced. Proceeded to retrospective.

## Defects routed but not blocking

- Filed as new issues (medium): 0
- Annotated as low: 4 (all carried from rounds 1–2; round-3 round did not introduce new ones)
  - LOW-1 (foot-gun): fields-limit-200 cap could miss DATE_TIME if workspace grows — `low-backlog.md` Queued table.
  - LOW-2 (foot-gun): views-coverage non-greedy `[\\s\\S]*?\\]` regex would mis-slice nested arrays — `low-backlog.md` Queued table.
  - LOW-3 (foot-gun): `parseInnerOrGraphqlArray` returns `[]` silently for unrecognised shapes — `low-backlog.md` Queued table.
  - LOW-4 (cosmetic): loose `Array<{fieldMetadataId?: string; operand?: string}>` typing in verification block — `low-backlog.md` Queued table.

## Surprises

Consolidated from each round's notes:

- **Round 1 (implementer):** "Plan's `beforeAll` parsed the wrong shape." The plan specified `parsed.result ?? []` but `metadata_query({kind: 'fields'})` routes through inner_tool transport, which returns a raw JSON array, not `{result: [...]}`. Implementer fixed defensively in round 1 with `Array.isArray(raw) ? raw : raw.result ?? []` inline. Same projection error then re-surfaced 50 lines below in the verification block — neither the implementer nor the original plan caught it. **Lesson surfaced as L-NEW-1 below.**

- **Round 1 (auditor):** Two HIGHs both traceable to "the same bug class at a sibling call site." HIGH-1: the strip was applied at the direct handler but not at the dispatch entry — same #9 bug, parallel location. HIGH-2: the shape parse was correct in `beforeAll` but wrong at the verification block — same shape-projection bug, parallel location. Both required reading adjacent code (R6: post-implementation adversarial audit by a different actor) to catch.

- **Round 2 (implementer):** "No surprises." The round-2 plan was precise; the implementation matched. But the implementer then placed the helper unit test inside the integration file — a "smell-test" decision that felt right (helper used by integration test, so co-locate) but was mechanically wrong because of the `testPathIgnorePatterns` config. The plan's test-plan item #6 made the verbal promise without specifying the file path constraint.

- **Round 2 (auditor):** The new HIGH was found by mechanically running the test by name against default config — the simplest possible verifier. The bug was not in any code: it was in file placement. R4's "every assertion has a mechanical verifier" applies recursively — the verifier itself must run, and the routing of tests across paths is a hidden axis where verifiers can be silently disabled.

- **Round 3 (implementer):** "Round-trip integration test has 10 tests now (not 13)" — the local helper describe block was removed; the 3 unit assertions migrated to the new file. Test count delta accounting (166 → 169 = +3 helper + 1 metadata - 1 placeholder removed) was load-bearing for verifying the round-3 mechanical gate.

- **Round 3 (auditor):** No surprises. The structural fix landed cleanly. But the test-routing fix is itself a foot-gun: if a future contributor moves the helper test back under `/integration/` for any reason ("organize by topic," "speed up default suite," etc.), the same bug class returns. Captured as round-3 R3 failure mode #3 (foot-gun, out of scope today).

## Lessons for institutional memory

For each lesson, propose where it should ingrain. The supervisor decides whether to wire it in — auditor only proposes.

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| **L-NEW-1: Shape-projection mistakes recur at sibling call sites.** When fixing one shape parse, grep for every other call site that parses a similar response and verify its shape. The original issue-3 audit-fix had this bug at one site; round 1 of this plan fixed `beforeAll` but copied the same mistake into the verification block; round 2 fixed both sites by introducing a single helper used at both. The pattern: a per-callsite fix is a hidden bet that the same projection isn't repeated elsewhere. **Generalisation: any per-callsite shape fix should be paired with a grep-and-replace pass across all sibling parsers, OR refactored to a single helper function.** | `packages/twenty-mcp/CLAUDE.md` (Lessons table) | This bug class has now shipped twice (issue-3 audit-fix → issue-7 round 1 → issue-7 round 1 verification block). The wrapper class generally returns shapes per-transport (inner_tool vs graphql vs metadata) and consumers parse them per-callsite; the shape-projection class is wrapper-specific. |
| **L-NEW-2: Layer 1 + Layer 2 must call the same function.** When a wrapper has both a direct handler and a dispatcher path (via apply_plan or similar), any input transformation that protects Layer 1 must be applied at Layer 2 too. The plan's "two-layer fix" pattern works only if both layers route through the same exported helper — anything copy-pasted will drift. Round 1 of issue-7 caught this exact bug class. The retrospective lesson is: when the wrapper has a dispatcher (apply_plan), every per-handler input transformation must either (a) be applied at the dispatcher level via `argsTransform` referencing the same exported helper, OR (b) be impossible to apply at the dispatcher level (in which case the asymmetry must be flagged in the dispatcher comment block). | `packages/twenty-mcp/CLAUDE.md` (Lessons table) | Twenty-mcp specifically has the dual-path apply_plan-vs-direct-handler architecture. Other packages (twenty-server, twenty-front) don't have this exact pattern. The lesson is wrapper-class wisdom that lives in the package CLAUDE.md. |
| **L-NEW-3: Test routing is part of the contract.** A test that is in `src/__tests__/integration/foo.test.ts` is silently NOT in the default suite — `testPathIgnorePatterns: /integration/` excludes it. When adding a unit test for a helper, the helper's test file must live OUTSIDE any path covered by `testPathIgnorePatterns`. The "verifier-of-the-verifier" mechanical gate (run the suite with no flags + grep for the test file's PASS line) catches this in round 3 of issue-7. **Generalisation: any test claim of the form "this test always runs" must be backed by a mechanical verifier that runs the test in the default jest invocation and confirms the test count includes it.** | root `CLAUDE.md` (Code Conventions / R-rule extension) OR `packages/twenty-mcp/CLAUDE.md` (Before-shipping checklist) | Repo-wide concern: anywhere a project has `testPathIgnorePatterns`, an "always runs" claim could be silently false. R4 (every assertion has a mechanical verifier) extends to: the verifier itself must run in the default configuration. |
| **L-NEW-4: Auditing across multiple rounds reveals "verifier-of-the-verifier" patterns.** Round 1 caught the bug; round 2 caught the closure of the bug at one layer up; round 3 caught the closure at the file-routing layer. Each round was the adversarial pre-mortem against the previous round's fix. The plan's **Round-3 critical change** language ("the helper is in its OWN module, and its unit tests live in a NON-integration file") is the codified output of this pattern. **Generalisation: when a fix introduces a new mechanism (a helper, a wrapper, a check), the audit must also verify that the new mechanism is itself exercised by the default test run. R4 applied recursively.** | `packages/twenty-mcp/CLAUDE.md` (Evaluation rules section, augmenting R4) | This is wrapper-package generality: the "trivial mechanical step" of writing a helper is invisible until you verify the helper-test is itself wired into the default suite. R4 currently says "every assertion has a mechanical verifier" — this lesson extends it to "every verifier must be exercised by the default configuration." |
| L-OBSERVED-5: When the plan's body promises a behavior ("test always runs"), the implementer should mechanically verify the promise BEFORE calling the work done. The promise becomes false at a layer the plan body didn't anticipate (file routing in round 2; could be CI runner config, environment env-var defaults, etc.). | (n/a — already covered by R1 + R4 in CLAUDE.md) | Pre-existing rule from CLAUDE.md; round-2 HIGH was a clear R1+R4 violation by the implementer. The retrospective notes this as a re-affirmation, not a new rule. |

## Diff summary

```
 packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness-audit-round-1.md | 117 ++++
 packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness-audit-round-2.md | 104 +++
 packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness-audit-round-3.md | 109 +++
 packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness-retrospective.md |  87 +++
 packages/twenty-mcp/plans/issue-7-views-test-infrastructure-brittleness.md               | 721 +++++++++++++++++++++
 packages/twenty-mcp/plans/low-backlog.md                                                |   4 +
 packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts                         |  52 +-
 packages/twenty-mcp/src/__tests__/metadata.test.ts                                       |  34 +
 packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts                           |  23 +
 packages/twenty-mcp/src/__tests__/views-coverage.test.ts                                 |  31 +-
 packages/twenty-mcp/src/__tests__/views.test.ts                                          |  22 +
 packages/twenty-mcp/src/tools/views.ts                                                   |  18 +-
 packages/twenty-mcp/src/utils/parse-metadata-array.ts                                    |  23 +
 13 files changed, 1325 insertions(+), 20 deletions(-)
```
