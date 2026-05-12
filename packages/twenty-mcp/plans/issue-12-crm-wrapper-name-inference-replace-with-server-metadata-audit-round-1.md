# Audit report: Replace wrapper name inference with server-side metadata fetch (issues #12 + #13) — round 1

> Plan: packages/twenty-mcp/plans/issue-12-crm-wrapper-name-inference-replace-with-server-metadata.md
> Round: 1
> Audited: 2026-05-12T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | 0 errors. |
| Lint (`npx nx lint twenty-mcp`) | INCONCLUSIVE | `lint:diff-with-main` target does not exist on this project. Plain `npx nx lint twenty-mcp` fails with `Failed to parse config /root/projects/fullstack/twenty-crm/twenty-crm/packages/twenty-mcp/.oxlintrc.json with error Os { code: 2, kind: NotFound, message: "No such file or directory" }`. Pre-existing condition — the file does not exist in `git log` history, and `twenty-front`/`twenty-server` have `.oxlintrc.json` but `twenty-mcp` does not. NOT caused by this diff. Same INCONCLUSIVE result was reported by issue #11's audit round 1. Treat as a pre-existing repo defect, not blocking this fix. |
| Full unit suite (`cd packages/twenty-mcp && npx jest --config jest.config.ts`) | PASS | Test Suites: 16 passed, 16 total. Tests: 212 passed, 212 total. Time: ~13s. |
| Contract test (`src/__tests__/contract.test.ts`) | PASS | 18 passed, 18 total. The mock stub's metadata-fetch branch correctly distinguishes `execute_tool({toolName:'get_object_metadata'})` from CRUD inner-tool calls; `lastInner()` returns the CRUD call (the metadata call returns early without setting `inner`). Branch logic is correct. |
| SDK boundary test | PASS | 2/2 passed. No registered tools added or removed. |
| Live integration suite (`round-trip.test.ts` against localhost:4440 + localhost:4441) | PASS | 27 passed, 27 total. New issue #12 block (6 tests) and issue #13 block (5 tests) all green; pre-existing people CRUD, link_note_to_record, operand-validation, and #11 multi-word CRUD all still green. Direct stack round-trip confirms `find_my_a_p_i_key_fixtures`, `create_company_analytics_fixture`, etc. route correctly through Twenty's record-crud path. |
| Adjacent-callers check | OK | `grep -rn 'innerToolName\|normalize' packages/twenty-mcp/src/` finds no callers of the removed `normalize()` / `innerToolName()` functions in production code. The `innerToolName` occurrences in `views.ts` / `metadata.ts` are object-literal field names on a different type (dispatch table), not the removed crm.ts function. The `innerToolName` references in `contract.test.ts` and `coverage.test.ts` are local variable names. Server.ts still registers all 5 CRM tools (`search_records`, `get_record`, `create_record`, `update_record`, `delete_record`) — `grep -n 'crm\|search_records' packages/twenty-mcp/src/server.ts`. |
| `pluralize` removed from crm files | OK | `grep -n 'pluralize' packages/twenty-mcp/src/tools/crm.ts src/__tests__/crm.test.ts src/__tests__/crm-coverage.test.ts` returns empty. `pluralize` is still in `package.json` (used by `coverage.test.ts` and `capture-inner-schemas.ts` — those are intentional per the plan's "Out of scope" note). |

## Defects found

### CRITICAL — none

### HIGH — none

### MEDIUM — file as new GitHub issue

1. **`get_object_metadata` fixture entry is hand-authored, not captured from the server (L1 violation)** (`packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json:9720-9732`)
   - What: The implementer added a `get_object_metadata` entry to `inner-tool-schemas.json` because `coverage.test.ts` scans `crm.ts` for `toolName: '<X>'` literals and fails if the literal isn't in the fixture. The hand-authored entry has `description: "List all object metadata items in the workspace. Returns nameSingular, namePlural, isCustom, isSystem, and other object metadata."` and `inputSchema: { properties: {}, additionalProperties: false }`. The real server-side schema (verified in `packages/twenty-server/src/engine/metadata-modules/object-metadata/tools/object-metadata-tools.factory.ts:106-124`) has:
     - **Description**: `"Find objects metadata. Retrieve information about the data model objects in the workspace."` (confirmed by the actual captured `tools-catalog.json:1080` which the implementer DID inspect).
     - **InputSchema**: `z.object({ id: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).default(100) })` — i.e. **accepts `{id?, limit?}` parameters with defaults, NOT empty input.**
   - Why medium: This is exactly the L1 ("capture, don't transcribe") bug class from `packages/twenty-mcp/CLAUDE.md`. Today the fixture entry is only used by `coverage.test.ts` for an EXISTENCE check (the key must be in the map), not a schema-shape check, so the lie doesn't currently cause a runtime defect. But: (a) it misleads any future reader who consults the fixture as ground truth about Twenty's API; (b) if a future contract test ever ajv-validates a call to `get_object_metadata` against this entry, it'd reject the correct `{}` input as "missing required limit" or accept wrong shapes; (c) it sets a precedent — the next time a wrapper adds a new inner tool name, the L1 rule has been demonstrably broken without consequence, weakening the structural defense. The same package's audit-retrospectives explicitly document that hand-transcribed schemas have cost ~1.1M tokens in production bugs.
   - Compounding defect: `STATIC_INNER_TOOL_NAMES` in `packages/twenty-mcp/scripts/capture-inner-schemas.ts:48-77` does NOT include `'get_object_metadata'`. So even when the implementer (or anyone) re-runs `npx tsx scripts/capture-inner-schemas.ts`, the hand-authored entry will NOT be refreshed from the live server — it'll silently persist as a stale lie. The capture script's merge logic (lines 145-173) preserves the existing key but only overwrites `schema` if the name appears in the requested capture set. The script needs `'get_object_metadata'` added to `STATIC_INNER_TOOL_NAMES`.
   - Evidence:
     ```
     # inner-tool-schemas.json line 9720
     "get_object_metadata": {
       "schema": {
         "name": "get_object_metadata",
         "description": "List all object metadata items in the workspace. Returns nameSingular, namePlural, isCustom, isSystem, and other object metadata.",
         "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
       },
       ...
     }
     # vs. server source (object-metadata-tools.factory.ts:106-124):
     get_object_metadata: {
       description: 'Find objects metadata. Retrieve information about the data model objects in the workspace.',
       inputSchema: z.object({ id: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).default(100) })
     }
     ```
   - Suggested fix (draft issue):
     - **Title**: `twenty-mcp: refresh hand-authored get_object_metadata fixture entry via capture script (L1 violation)`
     - **Body**:
       > Follow-up to #12. The fix for issues #12/#13 added a hand-authored entry for `get_object_metadata` to `packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json` (needed so `coverage.test.ts` could pass once `crm.ts`'s `resolveObjectNames` called `execute_tool({toolName:'get_object_metadata'})`). The entry's description and inputSchema are hand-transcribed and DIVERGE from the live server (verified in `packages/twenty-server/src/engine/metadata-modules/object-metadata/tools/object-metadata-tools.factory.ts:106-124`): server description is `"Find objects metadata..."`, server inputSchema accepts `{id?, limit?}` with `limit` defaulting to 100, fixture claims empty-only.
       >
       > Additionally, `packages/twenty-mcp/scripts/capture-inner-schemas.ts:48-77`'s `STATIC_INNER_TOOL_NAMES` does not include `'get_object_metadata'`, so re-running the capture script does NOT refresh this entry. The hand-authored stale schema persists indefinitely.
       >
       > **Fix**: (a) add `'get_object_metadata'` to `STATIC_INNER_TOOL_NAMES`; (b) re-run `npx dotenv -e .env.local -- npx tsx scripts/capture-inner-schemas.ts` against a live local Twenty; (c) verify the refreshed entry matches the server source; (d) commit the regenerated fixture.
       >
       > **Why it matters**: This is exactly the L1 ("capture, don't transcribe") bug class catalogued in `packages/twenty-mcp/CLAUDE.md`. Today it's a latent risk (only an existence check uses the entry); tomorrow when a contract test or schema-drift gate runs against this entry, the lie surfaces.

### LOW — varied routing per subcategory

1. **`resolveObjectNames` doc-comment claims "Preference order: exact case-sensitive match first" but the implementation only does case-insensitive matching** [TRIVIAL-IN-PLACE] (`packages/twenty-mcp/src/tools/crm.ts:61-63`)
   - What: The doc comment says "Preference order: exact case-sensitive match first, then case-insensitive. If two objects match under case-insensitive comparison, throws a disambiguation error naming both matches." The actual code lowercases `needle = input.trim().toLowerCase()` (line 94) and lowercases all 4 forms per object (lines 99-104), then matches via `forms.includes(needle)`. There is no case-sensitive pass before the case-insensitive pass. Two objects whose exact case-sensitive `nameSingular` matches (e.g., a user passes the exact string `'iOSDevice'` against a workspace with both `iOSDevice` and `iosdevice`) would throw an ambiguity error rather than preferring the exact-case match.
   - Why low: today the safety net (ambiguity throw) preserves correctness — no silent wrong routing. The user just sees an ambiguity error and has to provide an unambiguous form, which the error message instructs. The doc-comment lies but the consequence is bounded.
   - Subcategory rationale: TRIVIAL-IN-PLACE — either implement the case-sensitive-first pass (5-line edit: scan first for exact match, return immediately if exactly one; fall through to the existing case-insensitive logic) OR remove the misleading sentence from the doc-comment. Cost to absorb either edit: ~2 min. Cost of letting it land: a future reader trusts the comment and writes a test that fails, or a user reports "I passed the exact name but got ambiguity" and the response requires explaining the comment is wrong.
   - Suggested action: append a one-line edit to remove "Preference order: exact case-sensitive match first, then case-insensitive." from the doc-comment (the simpler fix), OR add a case-sensitive scan loop before the case-insensitive one. Re-run `npx jest src/__tests__/crm.test.ts src/__tests__/crm-coverage.test.ts --config jest.config.ts` to confirm green; estimated absorb time: 2 min.

2. **Implementer's surprise #4 reasoning about why `{myAPIKey, myApiKey}` doesn't ambiguate is incorrect; the fixture switch to `{testObject, testobject}` is fine but the rationale is wrong** [COSMETIC] (`packages/twenty-mcp/plans/issue-12-...md:392` Implementation notes — Surprises #4)
   - What: The Surprises note says `"camelToSnakeCase('myAPIKey') → my_a_p_i_key and camelToSnakeCase('myApiKey') → my_api_key — only one match, no ambiguity"`. This is wrong about the matching algorithm. `resolveObjectNames` matches by lowercasing ALL forms (nameSingular, namePlural, snake_singular, snake_plural) and comparing against the lowercased needle via `.includes()`. For input `'myapikey'`:
     - myAPIKey's lowercased forms: `['myapikey', 'myapikeys', 'my_a_p_i_key', 'my_a_p_i_keys']` → matches `'myapikey'`.
     - myApiKey's lowercased forms: `['myapikey', 'myapikeys', 'my_api_key', 'my_api_keys']` → ALSO matches `'myapikey'`.
     - Two candidates → ambiguity throw. The original fixture would have worked.
     The substituted `{testObject, testobject}` fixture also exercises ambiguity correctly (the lowercased forms collide on `'testobject'`), so the TEST COVERAGE is equivalent. But the implementer's stated reason for the substitution misdiagnoses the matching algorithm.
   - Why low: no behaviour impact — both fixtures correctly test the ambiguity-disambiguation safety net (the test case the plan's failure-mode #2 calls for). The defect is in the plan's Implementation notes section (a frozen historical record); the supervisor's `/audit-fix` skill appends annotations rather than editing the plan body.
   - Subcategory rationale: COSMETIC — the misdiagnosis lives in a historical record and didn't propagate to the code (the test still works). Marking it COSMETIC rather than TRIVIAL-IN-PLACE because the consequence is "future reader is confused if they trust this note" rather than "test could fail" or "code is wrong" — the same outcome as a typo in a retrospective.
   - Suggested action: backlog (cosmetic): note that the implementer's reasoning in surprises #4 of the plan is wrong (the case-insensitive `.toLowerCase().includes(needle)` matching WOULD have ambiguated `{myAPIKey, myApiKey}` on input `'myapikey'`); resolution: append to `packages/twenty-mcp/plans/low-backlog.md` Queued table for the next sweep.

3. **Stale proxy container at localhost:4441 — manual curl test (test plan item 12) is deferred until `docker compose build mcp` happens** [FOOT-GUN] (deployment-loop concern, not a code defect)
   - What: The MCP proxy container `twenty-local-mcp-1` is running a pre-built `twenty-mcp:local` Docker image that does NOT include this fix's source changes. The integration tests (`round-trip.test.ts`) import `buildCrmHandlers` directly from `'../../tools/crm'` — they bypass the proxy and execute the new source against the live Twenty stack at `localhost:4440`. This is the standard local dev-loop documented in `packages/twenty-mcp/CLAUDE.md` (Deployment loop section). The implementer correctly deferred item 12 because rebuilding the container is forbidden per the auditor/agent system prompt.
   - Why low: not a defect in the code — the implementer is doing the right thing per the constraints. The risk is purely deployment-procedural: any user testing the proxy via `curl -X POST http://localhost:4441/mcp ...` BEFORE the rebuild step happens will see the OLD "Tool not found" error and may misinterpret the fix as broken.
   - Subcategory rationale: FOOT-GUN — only matters if the rebuild step is skipped before user testing. The fix itself is correct; the proxy needs `docker compose build mcp && docker compose up -d mcp` to capture the source changes. Not cross-cutting (specific to this deployment hop). Not trivial-in-place (the auditor cannot execute the build).
   - Suggested action: backlog (foot-gun): supervisor must ensure `docker compose build mcp && docker compose up -d mcp` runs before declaring this fix ready for user testing via the localhost:4441 endpoint. The integration suite proves the source code is correct end-to-end against Twenty; the proxy rebuild is a separate ship step. Resolution: append to `packages/twenty-mcp/plans/low-backlog.md` Queued table, OR — better — capture as a step in the supervisor's pre-commit checklist.

4. **L1 mitigation: local `camelToSnakeCase` redefinition in `crm.ts` is byte-identical to `twenty-shared` today but could drift silently** [FOOT-GUN] (`packages/twenty-mcp/src/tools/crm.ts:18-19`)
   - What: The implementer added `const camelToSnakeCase = (str: string): string => str.replace(/[A-Z]/g, (letter) => \`_${letter.toLowerCase()}\`);` locally because the original plan's `import { camelToSnakeCase } from 'twenty-shared/utils'` failed at typecheck (twenty-shared had no compiled `dist/` at the time). Verified byte-identical to `packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts:1-2`. Today this is harmless. **But**: this is the structural change that the plan's R3 failure-mode warned about — if `twenty-shared`'s `camelToSnakeCase` ever evolves (e.g., handles a new Unicode case or trims leading underscores) and the wrapper's local copy doesn't, the whole point of the fix ("server stores `camelToSnakeCase(nameSingular)`, wrapper computes the same") is defeated and the L1 bug class returns. There is no automated drift detection between the local copy and `twenty-shared`'s source.
   - Why low: no defect today; bytes match. The fix-correctness invariant is currently satisfied. The risk is purely "future maintenance hazard."
   - Subcategory rationale: FOOT-GUN — only surfaces if `twenty-shared/camelToSnakeCase.ts` is modified by someone unaware of the twenty-mcp copy. Not blocking. Not trivial-in-place (the proper fix is "remove the local copy and import from twenty-shared once dist is reliably built", which is itself the deferred follow-up the implementer flagged). Not cross-cutting (specific to this one duplicated function).
   - Suggested action: backlog (foot-gun): add a tiny drift test that imports `camelToSnakeCase` from `twenty-shared/utils` (only when dist is available) and asserts it produces the same output as the local copy for a curated input list — OR — replace the local copy with the import once twenty-shared's `dist/` build is reliable in CI. Resolution: append to `packages/twenty-mcp/plans/low-backlog.md` Queued table. Cross-reference: this auditor verified twenty-shared's `dist/` was built by the `npx nx lint twenty-mcp` dependency chain during this audit, so the import-replacement may already be unblocked.

## Adversarial pre-mortem (R3 against the diff)

1. **A future contributor modifies `twenty-shared/src/utils/strings/camelToSnakeCase.ts` (e.g., to strip a leading underscore for PascalCase inputs) without touching `packages/twenty-mcp/src/tools/crm.ts`. The local copy diverges silently from the canonical algorithm.** No test catches this — `crm-coverage.test.ts` only asserts resolution outputs against a hand-curated fixture, not against `twenty-shared`'s algorithm. The 1.1M-token bug class is re-armed for any input pattern where the modified `twenty-shared` algorithm diverges from the local one. Tracked as LOW #4 (foot-gun). Mitigation: a single-file drift test (5 minutes of work) would close this.

2. **A user (or LLM agent) creates a custom object whose `nameSingular` starts with a capital letter (PascalCase, e.g. `Person`) — Twenty's nameSingular validation regex is `/^[a-z][a-zA-Z0-9]*$/` per the prior audit, so this SHOULD be rejected by Twenty server-side. If a future Twenty release relaxes that constraint, `camelToSnakeCase('Person')` produces `'_person'` (leading underscore) and the inner-tool lookup `find_one__person` fails. The wrapper's local copy AND `twenty-shared`'s copy both have this characteristic; neither strips a leading underscore. The server's `database-tool.provider.ts:117-118` does the same — so this would actually fail symmetrically at both ends. Not a defect introduced by this diff; pre-existing.** No action; covered by the existing first-letter-lowercase server validation.

3. **The metadata fetch adds one network round-trip per CRUD call. For an LLM agent that issues a long sequence of CRUD calls (e.g., 50 record creates in a loop), the cumulative latency is 50× the metadata-fetch round-trip on top of the actual create cost. Plan acknowledged this as out-of-scope (caching deferred). Verified the implementer did NOT accidentally introduce additional fetches: `grep -n 'toolsCall' packages/twenty-mcp/src/tools/crm.ts` shows exactly 2 sites (one in `resolveObjectNames`, one in `wrapInExecute`), confirming one metadata fetch + one CRUD call per handler invocation. The inline `TODO: add in-process TTL cache` comment is in place at line 68.** No defect; the latency cost is acknowledged. If this becomes a user-reported issue, the TTL cache follow-up is well-scoped.

## Recommendations to supervisor

- Block commit: **no** — zero critical, zero high.
- File new issues: **1 MEDIUM** (L1 violation in `get_object_metadata` hand-authored fixture entry + missing entry in capture script's `STATIC_INNER_TOOL_NAMES`; draft title + body in the MEDIUM section above).
- Annotate to plan / absorb pre-commit: **1 TRIVIAL-IN-PLACE LOW** (`resolveObjectNames` doc-comment lie about case-sensitive preference order). **3 LOWs to backlog** (`packages/twenty-mcp/plans/low-backlog.md` Queued table): the cosmetic surprise-note correction, the FOOT-GUN deployment-loop reminder for `docker compose build mcp`, and the FOOT-GUN drift hazard for the local `camelToSnakeCase` copy.
- Confidence in this audit: **high**.
  - All 10 mechanical gates ran (lint INCONCLUSIVE due to pre-existing missing `.oxlintrc.json` config; not a regression from this diff — same INCONCLUSIVE result was reported by the issue #11 audit).
  - Type check + full unit suite + contract test + sdk-boundary test + live integration suite all green.
  - Live round-trip against `localhost:4440` (Twenty) confirms the fix works end-to-end against a real workspace: 6 embedded-acronym tests + 5 mass-noun tests + all pre-existing regression tests pass.
  - Adjacent-callers grep confirms no stale callers of the removed `normalize()` / `innerToolName()` functions.
  - Server-side reference (`object-metadata-tools.factory.ts:106-124`) inspected to verify the hand-authored fixture entry IS divergent (the L1 finding).
  - The capture script (`capture-inner-schemas.ts`) was read to verify the new entry will not auto-refresh on re-capture.
