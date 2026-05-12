# Low-priority audit findings backlog — twenty-mcp

Findings that the audit pipeline categorised as `foot-gun` or `cosmetic`. Each entry is **queued** until the sweep threshold fires (count ≥ 5 by default, or manual via `/sweep-lows --force`); at sweep time, the queued entries are bundled into a single GitHub issue and run through the standard `/triage-issues → /implement-issue-fix → /audit-fix → /close-issue` pipeline. Swept entries move to the `Swept (history)` table for institutional memory; they are NOT deleted.

Threshold: `5` queued items. See `.claude/skills/sweep-lows/SKILL.md` for sweep mechanics; see `plans/2026-05-02-low-handling-policy.md` for the policy rationale.

## Queued

| Added | Source audit | Subcategory | One-line description | Suggested resolution |
|---|---|---|---|---|
| 2026-05-02 | [issue-1-...-audit-round-1.md](issue-1-apply-plan-placeholder-resolution-audit-round-1.md) (LOW 2) | foot-gun | `findUnresolved` returns the literal placeholder string and the error-message construction re-strips dollar/braces from it via a separate regex; if the placeholder regex is widened (e.g. for embedded placeholders), the error-message regex breaks → confusing "referenced mutation '...embedded $k1 here...'" messages | refactor `findUnresolved` to return both the matched location AND the extracted key, so the error message doesn't need to re-parse |
| 2026-05-02 | [issue-2-...-audit-round-1.md](issue-2-apply-plan-sha256-canonicalization-opaque-audit-round-1.md) (LOW 3) | cosmetic | redundant `TwentyMcpClient` import in `metadata.test.ts:6` (type was already inferred via `makeClient`'s return type) | remove the explicit import; rely on the inferred type |
| 2026-05-02 | [issue-3-...-audit-round-2.md](issue-3-apply-plan-operand-field-type-validation-audit-round-2.md) (L-1) | cosmetic | prettier drift expanded by ~150+ lines across 6 changed files (FIELD_TYPE_OPERAND_MAP table-style format, OPERAND_MATRIX_DESCRIPTION template literal, new test files) | run `npx nx lint twenty-mcp --configuration=fix` once `.oxlintrc.json` is added (depends on the cross-cutting infra fix from issue-1's L-3) |
| 2026-05-02 | [issue-3-...-audit-round-2.md](issue-3-apply-plan-operand-field-type-validation-audit-round-2.md) (L-3) | foot-gun | `views-coverage.test.ts:31-34` skips the test silently via `it.skip(...)` if `TWENTY_FRONT_SOURCE` doesn't exist (e.g., future twenty-front rename/move). A silently skipped test loses the drift-gate without a CI signal | replace `it.skip(...)` with `throw new Error('twenty-front source file moved or missing — update TWENTY_FRONT_SOURCE path in views-coverage.test.ts')` for a loud rename-time alarm |
| 2026-05-03 | [issue-7-...-audit-round-3.md](issue-7-views-test-infrastructure-brittleness-audit-round-3.md) (L-1) | foot-gun | `round-trip.test.ts beforeAll` caps fields query at 200 — could miss DATE_TIME if workspace field count exceeds limit and ordering pushes it past page boundary; the round-2-improved error message would misleadingly say "array of 200" implying complete data | page through all field-metadata results in `beforeAll`, OR query `kind: 'objects'` first to find a known stock object (e.g. `company`) and then query its fields directly via `objectMetadataId` filter to get a small focused list |
| 2026-05-03 | [issue-7-...-audit-round-3.md](issue-7-views-test-infrastructure-brittleness-audit-round-3.md) (L-2) | foot-gun | `views-coverage.test.ts` spread declaration regex uses non-greedy `[\s\S]*?\]` — would mis-slice if a spread const contains nested arrays (current twenty-front has only flat operand lists, so works today) | switch to a balanced-bracket scan analogous to the FILTER_OPERANDS_MAP block scan, or migrate to TypeScript compiler API |
| 2026-05-03 | [issue-7-...-audit-round-3.md](issue-7-views-test-infrastructure-brittleness-audit-round-3.md) (L-3) | foot-gun | `parseInnerOrGraphqlArray` returns `[]` for unrecognised shapes — would silently no-op the verification block again if a future Twenty API change returns a third envelope shape (e.g., `{data: [...]}`, paginated `{rows: [...], total: 1}`); same Tested-because-mock-passes class as round-1 HIGH-2 | throw on unrecognised shape (`throw new Error('parseInnerOrGraphqlArray: input is neither raw array nor {result: [...]}; got top-level keys [...]')`) so a shape drift fires loud rather than silent no-op |
| 2026-05-03 | [issue-7-...-audit-round-3.md](issue-7-views-test-infrastructure-brittleness-audit-round-3.md) (L-4) | cosmetic | `round-trip.test.ts` verification block uses loose `Array<{fieldMetadataId?: string; operand?: string}>` typing — both fields optional; could mask a regression where Twenty returns rows with malformed `fieldMetadataId` (e.g. number) | provide a Zod schema for view_filter rows in `parse-metadata-array.ts` and runtime-validate the parsed array, so any shape drift surfaces as a parse failure |
| 2026-05-03 | [issue-6-...-audit-round-1.md](issue-6-sdk-tools-list-boundary-test-audit-round-1.md) (LOW-2) | foot-gun | sdk-boundary.test.ts only exercises `enableMetadata: true`; wouldn't catch a regression where a tool migrates across the `if (enableMetadata)` boundary in `server.ts` (e.g., a metadata tool accidentally moved into the always-on path) | parametrise the `describe` block over both `enableMetadata: true` and `enableMetadata: false`; assert the `false` case registered set equals `{discovery, search_records, get_record, create_record, update_record, delete_record, link_note_to_record}` (the seven baseline families) |
| 2026-05-12 | [issue-11-...-audit-round-1.md](issue-11-inner-tool-name-camelcase-boundary-audit-round-1.md) (LOW-3) | cosmetic | `crm-coverage.test.ts:21-26` uses throw-on-missing-source pattern; sibling `views-coverage.test.ts:31` uses `it.skip` on missing source — pattern inconsistency across `*-coverage.test.ts` files | standardize on one pattern across `*-coverage.test.ts` files in twenty-mcp; throw is stricter (forces lockstep update), skip is more forgiving (CI doesn't fail if `twenty-shared` is restructured before the test path is updated) — pick one and apply consistently |

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
| 2026-05-02 | issue-3-...-audit-round-2.md (L-2) | trivial-in-place | integration test asserts wrapper rejected the operand but doesn't independently verify Twenty was never touched (no DB-state check) | (pending — round-2 commit for issue #3 fix) |

## Filed as separate issues (history — for traceability of cross-cutting LOWs)

| Date | Source audit | One-line description | Issue number |
|---|---|---|---|
| 2026-05-02 | issue-2-...-audit-round-1.md (LOW 2) | no test exercises the MCP SDK `tools/list` boundary for any metadata tool (cross-cutting gap shared by all metadata wrappers) | [#6](https://github.com/LazyBouy/twenty-crm/issues/6) |
