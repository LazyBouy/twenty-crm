# Retrospective: Low-priority audit findings sweep — 10 items

> Issue(s): #14
> Plan: packages/twenty-mcp/plans/issue-14-low-sweep.md
> Audit cycles: 2 (round 1 hit an auditor-self-inflicted incident; round 2 confirmed recovery + clean)
> Commit: pending — filled by closer post-commit
> Written: 2026-05-12T15:10:12Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Item 1 (`findUnresolved` returns `{location, key}`): refactor to structured object; tests pass | Partial — returned `{ key: string }` only (no `location`). All 54 metadata tests pass including the new error-message-key assertion. Behaviour-equivalent to the plan's intent. |
| Item 2: remove redundant `TwentyMcpClient` import | Surprise: full removal would break `as unknown as TwentyMcpClient` casts. Implementer correctly substituted `import type { TwentyMcpClient }` instead — achieves the same goal (no runtime import, lint-safe). |
| Item 3: prettier-clean the 6 plan-listed files | Done; also reformatted `metadata.ts` (was already `import type` from the production source). Surprise during the audit: `crm.ts` had pre-existing prettier drift from #12+#13 — outside #14's scope, did not block. |
| Item 4: `it.skip` → throw with loud error message | Done; throw at lines 40-44 with loud-alarm comment. Surprise: the plan's verification command (`TWENTY_FRONT_SOURCE=/nonexistent`) is non-functional because the path is computed at module-load via `join(__dirname, ...)`, not from env. Implementation is correct; verification command misleading — backlogged as LOW-4 cosmetic. |
| Item 5: focused `objectMetadataId`-filtered query | Done; round-trip.test.ts now does two queries (companyId → company fields). 27/27 integration tests pass against local Twenty. |
| Item 6: balanced-bracket scanner replaces non-greedy regex | Done with surprise — the main `FILTER_OPERANDS_MAP` block already used balanced-bracket scanning before this plan; only the inner spread-declaration lookup still used the non-greedy regex. Fix was applied there. |
| Item 7: throw on unrecognised shape instead of silent `[]` | Done. Audit absorbed LOW-1 pre-commit: the throw message now uses a `describe()` helper so `null`, arrays, objects, and primitives all produce a clear diagnostic instead of stringified keys. |
| Item 8: Zod runtime validation for view-filter rows | **Deferred** per Out-of-scope clause. Round-1 audit found that no follow-up issue was filed (the implementation note said "file as #15 or next available"); supervisor filed as #17. Worst-case bug class on deferral: Tested-because-mock-passes — explicitly named per R2. |
| Item 9: parametrise sdk-boundary over both `enableMetadata` values | Done; both `describe` blocks pass (5/5). The `false` block asserts exactly 7 baseline tools — accidental migration of a metadata tool out of the `if (enableMetadata)` guard would now fail this test. |
| Item 10: confirm coverage-test pattern consistency | Mostly moot. `crm-coverage.test.ts` was rewritten by the in-flight #12+#13 diff into a resolution-logic test (no "throw on missing source" pattern remaining). Item 4 resolved the `views-coverage.test.ts` side. `grep` confirms no `it.skip` in any `*-coverage.test.ts` file. |
| R3 failure mode 1: dependency-violating order causes rework | Did not surface. Implementer followed the plan order (cosmetics first, then foot-guns). |
| R3 failure mode 2: cosmetic fix triggers lint regression | Did not surface — typecheck remained clean after item 3. |
| R3 failure mode 3: sweep items rot after partial implementation | Did not surface. 9 of 10 items completed atomically; item 8 was deferred deliberately per Out-of-scope. The rot risk DID re-surface as MEDIUM-2 in audit round 1 (no follow-up filed) — caught and routed to #17. |

## Audit journey

**Round 1: CRITICAL — auditor caused destructive working-tree state change.** Pre-incident, all 10 items verified (218/218 unit + 27/27 integration + 18/18 contract + 5/5 sdk-boundary). 2 MEDIUMs + 5 LOWs identified. During item-3 verification, the auditor ran `npx prettier --write` against `src/tools/crm.ts` (intent: inspect diff prettier would produce); then ran `git checkout -- crm.ts` (intent: revert). Both were destructive — `prettier --write` modified the file in place, and the in-flight #12+#13 changes to crm.ts were unstaged, so the `git checkout` discarded them along with the prettier changes. `git fsck --lost-found` produced no candidate blob (no stash/index ever existed). Two test suites fell into compile-fail (TS2305 on `buildToolName`, `resolveObjectNames`). Round 1 ended in BLOCKED status; the round-1 report includes a prominent "INCIDENT NOTICE" section documenting the rule violation.

**Recovery (supervisor):** Extracted the original TypeScript from the jest transform cache's sourcemap at `/tmp/jest_0/.../crm_*.map` — the `sourcesContent[0]` field contains the source as ingested by the most recent jest run. Restored crm.ts; verified with 218/218 unit-suite, 27/27 integration suite (live against `twenty-local-*` containers), 18/18 contract, 5/5 sdk-boundary, 0 typecheck errors.

**Round 2 (this round): CLEAN.** Re-ran all 10 gates read-only. Confirmed:
- crm.ts contains all expected symbols at the expected line numbers (resolveObjectNames at 70-128, buildToolName at 137-154, local camelToSnakeCase at 18-19).
- All 7 round-1 findings remain valid against the recovered state and are routed correctly: MEDIUMs as #16 and #17, cross-cutting LOW as #18, trivial-in-place LOW absorbed pre-commit (the `describe()` helper in parse-metadata-array.ts:27-32), 3 foot-gun/cosmetic LOWs backlogged in `low-backlog.md` Queued table (lines 14-16).
- No new defects introduced by the recovery.

## Defects routed but not blocking

- **Filed as new issues (medium):** #16 (views-coverage white-box duplicate regression test), #17 (Zod row schema deferred from item 8).
- **Filed as new issues (low cross-cutting):** #18 (twenty-mcp lacks `lint:diff-with-main` project.json target).
- **Absorbed pre-commit (trivial-in-place):** parseInnerOrGraphqlArray throw-message `describe()` helper (verified in `src/utils/parse-metadata-array.ts:27-32`).
- **Backlogged in `packages/twenty-mcp/plans/low-backlog.md` Queued table:** three rows from this audit (LOW-3 crm.ts `candidates[0]` non-null access; LOW-4 plan item-4 verification command misleading; LOW-5 parseInnerOrGraphqlArray test gap for null input).

## Surprises

Consolidated from both rounds.

1. **Item 2 fix shape: type-only import, not removal.** The plan said "remove line 6." The actual file had many `as unknown as TwentyMcpClient` casts that need the type. The right fix was `import type { TwentyMcpClient }` — same lint outcome, type still available, no behaviour change. Plan template-language is fine for one-shot removals but should not be taken literally when adjacent code references the type.

2. **Item 4 verification command was non-functional.** `TWENTY_FRONT_SOURCE=/nonexistent npx jest ...` cannot trigger the throw because the test computes the path at module-load via `join(__dirname, ...)`, not from `process.env`. Backlogged as LOW-4 cosmetic. Future plan templates that propose "set env var X to invalid; expect throw" must verify the test file actually reads the env var.

3. **Item 6 partial fix: the main parser was already balanced-bracket; only the inner spread-declaration lookup used non-greedy regex.** The plan implied the whole file needed the rewrite. In reality only one regex was problematic. This is the kind of "claim wider than evidence" pattern that R3 should catch in future plans — the audit author should re-grep before declaring the bug surface.

4. **Item 10 was moot before round 1 even started.** `crm-coverage.test.ts` had been rewritten by the in-flight #12+#13 diff into a resolution-logic test with no throw-on-missing-source pattern. The plan was written assuming the old crm-coverage shape; the implementation correctly recognised the change and degraded item 10 to a one-line grep verification.

5. **prettier also reformatted `metadata.ts` outside the listed scope.** Adjacent in-flight files can be silently formatted by `prettier --write *.ts` (depending on scope). Implementers should pass explicit file paths to prettier, never wildcards.

6. **The auditor-incident itself (round 1).** Documented in detail in the round-1 report and below in "Lessons." The single most important surprise of this whole cycle: an auditor with `Write` permission for two specific paths still had `Bash` permission to run destructive shell commands, and used it. The audit-agent prompt forbids modifying source files but did not explicitly enumerate the destructive bash patterns (`prettier --write`, `git checkout`, `rm`, `mv`). Closed via the L13 ingrain proposal below.

7. **Sourcemap-cache recovery is a real fallback for lost working-tree state.** Jest's transformer (ts-jest / swc) writes a `.map` with `sourcesContent[0]` containing the input source verbatim. As long as the file was loaded by at least one recent jest run, the cache is a recovery vector. This is a one-off rescue, not a routine workflow — but worth knowing it exists.

## Lessons for institutional memory

Each lesson below proposes an ingrain target. The supervisor decides whether to wire it in.

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| **L13: The auditor MUST NEVER run destructive shell commands against working-tree files.** Forbidden: `prettier --write`, `git checkout --`, `git reset`, `git restore`, `rm`, `mv`, any `--write` / `-i` / `-f` form. Allowed (read-only): `prettier --check`, `git status`, `git diff`, `git log`, `git show`, `cat`, `grep`. The audit-agent prompt enumerates allowed *writes* (audit-round files only); it must also enumerate forbidden destructive *bash* patterns. | `.claude/agents/issue-auditor.md` (auditor system prompt, "Hard prohibitions" section) — add an explicit allow-list of read-only inspection commands and an explicit deny-list of write/mutate commands. | This codebase has now produced a CRITICAL incident from exactly this gap. The prompt forbids `Write`-tool targets outside two paths but does not forbid bash-shell destructive ops. Codifying the deny-list closes the loophole. |
| **L14: When an auditor wants to inspect a "would-be" formatting diff, use `npx prettier --check` (exit code reflects drift; no file modification) or `git diff <file> \| less` — never `--write`.** Captured as a corollary of L13 but worth its own line because it is the specific command that caused the round-1 incident. | `.claude/agents/issue-auditor.md` — corollary inside the new deny-list section. | Specific enough to internalise; vague enough to apply to other tools (eslint --fix, biome check --apply, etc.). |
| **L15: Sourcemap-cache recovery is a documented last-resort for lost working-tree TypeScript files.** `/tmp/jest_*/.../<file>_<hash>.map` `sourcesContent[0]` holds the input verbatim. Cache survives as long as jest has run the file recently and the temp dir is intact. | `packages/twenty-mcp/CLAUDE.md` (a new short "Recovery" section, or extend the existing "Plans + retrospectives" pointer). | Twenty-mcp-specific because this is the package whose audit hit the incident; generalises to any TS package with ts-jest/swc. |
| **L16: Plans that specify "remove import X" / "remove line N" MUST be verified against actual references before implementation.** The grep is one command; the consequence of being wrong is a broken file. Captured here from item-2's surprise. | `.cursor/rules/code-style.mdc` (or the closest existing "before-editing" rule). | Repo-wide: applies to any plan-driven edit in any package. |
| **L17: Plan-supplied verification commands MUST themselves be tested — at least mentally — before being followed verbatim.** Item 4's `TWENTY_FRONT_SOURCE=/nonexistent` looked right but couldn't trigger the throw because the path was computed at module-load. This is a sub-class of "Verified-because-source-says-so" in the existing flawed-framings catalog. | `packages/twenty-mcp/CLAUDE.md` (Flawed framings catalog) — add `Verified-because-plan-command-runs` or similar. | Twenty-mcp-specific because this is where the catalog lives; the pattern itself is repo-general. |
| (n/a) | Surprises 3-5 above are too narrow / one-off to ingrain — backlog as `low-backlog.md` cosmetics if they recur. | (no ingrain — narrow) | These are specific to this sweep's items and unlikely to recur in the same shape. |

## Diff summary

```
 packages/twenty-mcp/lib/index.js                                  |    0
 packages/twenty-mcp/package.json                                  |    1 +
 packages/twenty-mcp/plans/...-camelcase-boundary-retrospective.md |   18 +-
 packages/twenty-mcp/plans/low-backlog.md                          |   18 +-
 packages/twenty-mcp/src/__tests__/contract.test.ts                |   57 +-
 packages/twenty-mcp/src/__tests__/crm-coverage.test.ts            |  344 +++++--
 packages/twenty-mcp/src/__tests__/crm.test.ts                     |  356 +++++--
 packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json|   37 +-
 packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts  | 1003 ++++++++++++++------
 packages/twenty-mcp/src/__tests__/metadata.test.ts                |  374 ++++++--
 packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts    |   33 +-
 packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts            |   86 +-
 packages/twenty-mcp/src/__tests__/views-coverage.test.ts          |  134 ++-
 packages/twenty-mcp/src/__tests__/views.test.ts                   |  118 ++-
 packages/twenty-mcp/src/tools/crm.ts                              |  191 +++-
 packages/twenty-mcp/src/tools/metadata.ts                         |  181 +++-
 packages/twenty-mcp/src/tools/views.ts                            |  192 +++-
 packages/twenty-mcp/src/utils/parse-metadata-array.ts             |   25 +-
 18 files changed, 2432 insertions(+), 736 deletions(-)
```

(Note: the full stat above includes #12+#13 in-flight changes co-committed with the #14 sweep. The #14 plan's own scope was the 7 files listed in its Implementation notes "Files changed" block; the rest belong to #12+#13.)
