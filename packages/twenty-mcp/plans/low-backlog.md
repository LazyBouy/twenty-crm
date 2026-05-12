# Low-priority audit findings backlog — twenty-mcp

Findings that the audit pipeline categorised as `foot-gun` or `cosmetic`. Each entry is **queued** until the sweep threshold fires (count ≥ 5 by default, or manual via `/sweep-lows --force`); at sweep time, the queued entries are bundled into a single GitHub issue and run through the standard `/triage-issues → /implement-issue-fix → /audit-fix → /close-issue` pipeline. Swept entries move to the `Swept (history)` table for institutional memory; they are NOT deleted.

Threshold: `5` queued items. See `.claude/skills/sweep-lows/SKILL.md` for sweep mechanics; see `plans/2026-05-02-low-handling-policy.md` for the policy rationale.

## Queued

| Added | Source audit | Subcategory | One-line description | Suggested resolution |
|---|---|---|---|---|
| 2026-05-12 | [issue-14-...-audit-round-1.md](issue-14-low-sweep-audit-round-1.md) (LOW-3) | foot-gun | `crm.ts` `resolveObjectNames`: after the candidates-list reduction, `candidates[0].nameSingular` and `candidates[0].namePlural` are accessed without optional chaining. TypeScript strict mode allows it because the prior line checks `candidates.length === 1`, but a subtle refactor (e.g. changing to `>= 1`) would re-introduce undefined-access without a type error | change `candidates[0].name*` to `candidates[0]!.name*` (assert) OR convert to `const [only] = candidates; return {nameSingular: only.nameSingular, ...}` after the explicit guard. 1-line edit in a future refactor |
| 2026-05-12 | [issue-14-...-audit-round-1.md](issue-14-low-sweep-audit-round-1.md) (LOW-4) | cosmetic | Plan packages/twenty-mcp/plans/issue-14-low-sweep.md item 4's verification command uses `TWENTY_FRONT_SOURCE=/nonexistent` to verify the throw fires, but the test file computes the path at module load via `join(__dirname, ...)`, not from `process.env` — so the env-var override doesn't work. The implementation is correct; only the plan's verification instructions are misleading | update future similar plan templates to read the env var or use `mv` to rename the file at test setup |
| 2026-05-12 | [issue-14-...-audit-round-1.md](issue-14-low-sweep-audit-round-1.md) (LOW-5) | foot-gun | `parseInnerOrGraphqlArray` test does NOT cover a `null` input (`JSON.stringify(null)`). The throw branch handles it correctly (via the new `describe()` helper post-LOW-1 absorption), but no test asserts it. If a future refactor breaks the `raw === null` branch, no test catches the regression | add `expect(() => parseInnerOrGraphqlArray('null')).toThrow(/unrecognised response shape/);` to parse-metadata-array.test.ts. 3-line test addition |

## Swept (history)

| Swept on | Sweep issue | Items | Plan path | Closed in |
|---|---|---|---|---|
| 2026-05-12 | [#14](https://github.com/LazyBouy/twenty-crm/issues/14) | 10 items spanning 2026-05-02..2026-05-12: foot-guns (findUnresolved/error-msg coupling; views-coverage skip-on-missing; fields-limit-200; views-coverage non-greedy regex; parseInnerOrGraphqlArray silent `[]`; sdk-boundary enableMetadata=true only) and cosmetics (TwentyMcpClient redundant import; prettier drift; loose row typing; coverage-test pattern inconsistency) | (pending — to be filled by triager) | (pending — to be filled by closer) |

## Absorbed pre-commit (history — for traceability of trivial-in-place LOWs that didn't go through the backlog)

For completeness, LOWs that were absorbed pre-commit (so they never appeared in the Queued table) are logged here as a one-line history.

| Date | Source audit | Subcategory | One-line description | Absorbed in commit |
|---|---|---|---|---|
| 2026-05-02 | issue-1-...-audit-round-1.md (LOW 1) | trivial-in-place | broad catch comment understates swallow scope (rewrote in round 2) | 91a42885ef (issue #1 fix) |
| 2026-05-02 | issue-2-...-audit-round-1.md (LOW 1) | trivial-in-place | byte-for-byte warning missing from `metadata_compute_plan_hash` description | 8906f92105 (issue #2 fix) |
| 2026-05-02 | issue-3-...-audit-round-2.md (L-2) | trivial-in-place | integration test asserts wrapper rejected the operand but doesn't independently verify Twenty was never touched (no DB-state check) | (pending — round-2 commit for issue #3 fix) |

## Filed as separate issues (history — for traceability of cross-cutting LOWs)

| Date | Source audit | One-line description | Issue number |
|---|---|---|---|
| 2026-05-02 | issue-2-...-audit-round-1.md (LOW 2) | no test exercises the MCP SDK `tools/list` boundary for any metadata tool (cross-cutting gap shared by all metadata wrappers) | [#6](https://github.com/LazyBouy/twenty-crm/issues/6) |
