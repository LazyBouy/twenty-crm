# Low-priority audit findings backlog — twenty-mcp

Findings that the audit pipeline categorised as `foot-gun` or `cosmetic`. Each entry is **queued** until the sweep threshold fires (count ≥ 5 by default, or manual via `/sweep-lows --force`); at sweep time, the queued entries are bundled into a single GitHub issue and run through the standard `/triage-issues → /implement-issue-fix → /audit-fix → /close-issue` pipeline. Swept entries move to the `Swept (history)` table for institutional memory; they are NOT deleted.

Threshold: `5` queued items. See `.claude/skills/sweep-lows/SKILL.md` for sweep mechanics; see `plans/2026-05-02-low-handling-policy.md` for the policy rationale.

## Queued

| Added | Source audit | Subcategory | One-line description | Suggested resolution |
|---|---|---|---|---|
| 2026-05-02 | [issue-1-...-audit-round-1.md](issue-1-apply-plan-placeholder-resolution-audit-round-1.md) (LOW 2) | foot-gun | `findUnresolved` returns the literal placeholder string and the error-message construction re-strips dollar/braces from it via a separate regex; if the placeholder regex is widened (e.g. for embedded placeholders), the error-message regex breaks → confusing "referenced mutation '...embedded $k1 here...'" messages | refactor `findUnresolved` to return both the matched location AND the extracted key, so the error message doesn't need to re-parse |
| 2026-05-02 | [issue-2-...-audit-round-1.md](issue-2-apply-plan-sha256-canonicalization-opaque-audit-round-1.md) (LOW 3) | cosmetic | redundant `TwentyMcpClient` import in `metadata.test.ts:6` (type was already inferred via `makeClient`'s return type) | remove the explicit import; rely on the inferred type |

## Swept (history)

| Swept on | Sweep issue | Items | Plan path | Closed in |
|---|---|---|---|---|
| (none yet) | | | | |

## Absorbed pre-commit (history — for traceability of trivial-in-place LOWs that didn't go through the backlog)

For completeness, LOWs that were absorbed pre-commit (so they never appeared in the Queued table) are logged here as a one-line history.

| Date | Source audit | Subcategory | One-line description | Absorbed in commit |
|---|---|---|---|---|
| 2026-05-02 | issue-1-...-audit-round-1.md (LOW 1) | trivial-in-place | broad catch comment understates swallow scope (rewrote in round 2) | 91a42885ef (issue #1 fix) |
| 2026-05-02 | issue-2-...-audit-round-1.md (LOW 1) | trivial-in-place | byte-for-byte warning missing from `metadata_compute_plan_hash` description | 8906f92105 (issue #2 fix) |

## Filed as separate issues (history — for traceability of cross-cutting LOWs)

| Date | Source audit | One-line description | Issue number |
|---|---|---|---|
| 2026-05-02 | issue-2-...-audit-round-1.md (LOW 2) | no test exercises the MCP SDK `tools/list` boundary for any metadata tool (cross-cutting gap shared by all metadata wrappers) | [#6](https://github.com/LazyBouy/twenty-crm/issues/6) |
