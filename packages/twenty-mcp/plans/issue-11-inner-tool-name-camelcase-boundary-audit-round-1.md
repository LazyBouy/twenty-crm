# Audit report: fix innerToolName camelCase boundary loss (issue #11) — round 1

> Plan: packages/twenty-mcp/plans/issue-11-inner-tool-name-camelcase-boundary.md
> Round: 1
> Audited: 2026-05-12T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | tsc clean; tests excluded from typecheck per `tsconfig.json` `exclude`. |
| Lint (diff-with-main) | INCONCLUSIVE | `lint:diff-with-main` target not configured for twenty-mcp (`project.json` has `"lint": {}` and no eslint config in the package). Pre-existing infra gap, NOT introduced by this PR. `npx eslint` errors out without `eslint.config.*`. |
| Full unit suite (`npx jest --config jest.config.ts`) | PASS | 205 / 205 passed across 16 suites in 15.9 s. Matches plan's expected count. |
| Contract suite (`npx jest src/__tests__/contract.test.ts`) | PASS | 18 / 18 passed. Adjacent regression check clean. |
| Integration round-trip (live, triple-gated) | PASS | 16 / 16 passed in 4.65 s. All 6 new issue-#11 tests green against the running local stack (localhost:4440 + localhost:4441). |
| Stack health (pre-condition) | PASS | `curl -sf http://localhost:4440/healthz` returned 200 with `{"status":"ok"}`. MCP `initialize` round-trip OK. |
| Cleanup verification | PASS | After integration suite, `mcpAuditFixture` is absent from workspace (verified via direct `/metadata` GraphQL `objects(paging:{first:200})` query — zero matches in returned payload). `afterAll` `deleteOneObject` mutation executed correctly. |
| Adjacent-callers check | OK | `innerToolName` is only invoked from `crm.ts` lines 150/156/158/160/165. Property-key uses of the string `innerToolName` in `metadata.ts` and `views.ts` dispatch tables are unrelated (literal field names of dispatch records, not function calls). `discovery.ts`'s `toLowerCase()` is for filter matching only — not identifier computation. Phase 1 sweep's claim holds. |
| Test integrity (R6 / Tested-because-mock-passes) | OK | The new unit assertions in `crm.test.ts` are output-pinning (compare `innerToolName(...)` against the expected snake-case string). The new `crm-coverage.test.ts` re-derives the expected output by running the canonical `camelToSnakeCase` algorithm (loaded from `twenty-shared` at test time), so it is mechanically anchored to ground truth — not to a mock of itself. Integration tests exercise the live stack end-to-end. |

## Defects found

### CRITICAL — none

### HIGH — none

### MEDIUM — file as new GitHub issue

1. **Embedded-acronym camelCase names diverge between wrapper and server (NOT documented in plan)** (packages/twenty-mcp/src/tools/crm.ts:29-46)
   - What: For object names that start with a lowercase letter but contain consecutive capitals later in the string (e.g. `iOSDevice`, `myURLToken`, `appAPIKey`, `userIPAddress`, `schemaURL`), the wrapper's regex `([a-z0-9])([A-Z])` only inserts ONE underscore at the first lowercase→capital boundary; the server's `camelToSnakeCase` inserts an underscore before EVERY capital. Concrete divergences:
     - `iOSDevice` → wrapper `i_osdevice` vs server `i_o_s_device`
     - `myURLToken` → wrapper `my_urltoken` vs server `my_u_r_l_token`
     - `appAPIKey` → wrapper `app_apikey` vs server `app_a_p_i_key`
     - `userIPAddress` → wrapper `user_ipaddress` vs server `user_i_p_address`
     - `schemaURL` → wrapper `schema_url` vs server `schema_u_r_l`
   - Why medium: Twenty's object-name validation regex is `/^[a-z][a-zA-Z0-9]*$/` (verified in `packages/twenty-server/src/engine/metadata-modules/flat-object-metadata/validators/utils/validate-flat-object-metadata-name.util.ts:14`). Names like `iOSDevice` and `myAPIKey` PASS this validation (they start with lowercase). So these names are **reachable** via Twenty's `createOneObject` API. Any workspace with such a custom object hits the exact same "Tool not found" failure mode as issue #11 reports for the standard camelCase case. The plan's failure-mode #1 claims "consecutive-capital object names are not producible via the standard Twenty UI/API" — this is **incorrect** for lowercase-first names with embedded acronyms.
   - Evidence:
     ```
     // Server regex permits this:
     /^[a-z][a-zA-Z0-9]*$/.test('iOSDevice')  // true
     // But the wrapper's normalize() diverges from server camelToSnakeCase:
     wrap('iOSDevice') === 'i_osdevice'        // wrapper
     serv('iOSDevice') === 'i_o_s_device'      // server (canonical)
     ```
   - Why this is MEDIUM (not HIGH): the bug is latent for the common case (most custom object names are pure camelCase without internal acronyms — `schemaChangeAudit`, `customerHealth`, `noteTarget`, etc., all of which the regex handles correctly). Production impact is bounded to workspaces that have intentionally named an object with an embedded acronym. The fix for issue #11 *as filed* (multi-word custom objects) is correct and unblocks the reporter's use case; this is a residual gap that warrants a separate follow-up rather than blocking this PR.
   - Why this is NOT just a "foot-gun LOW": the bug class IS present today on any workspace with an `iOSDevice`-pattern object name. It isn't "latent only if some other change happens later" — the workspace shape that triggers it is already legal in production. Compare to the pluralize-mass-noun bug class, which the plan already filed for follow-up: this embedded-acronym class has the same severity profile (production-impacting subset of custom-object names) and the same fix shape (capture from server-emitted `nameSingular`/`namePlural` instead of inferring).
   - Suggested fix: file as new GitHub issue. Draft:
     - **Title**: `twenty-mcp: CRM wrappers fail for camelCase object names with embedded acronyms (e.g. iOSDevice, myAPIKey)`
     - **Body**:
       > Follow-up to #11. After the camelCase-boundary regex fix, the wrapper still diverges from server's `camelToSnakeCase` for object names containing consecutive capitals (acronyms) in the middle of the name. Affected pattern: lowercase-first camelCase with embedded acronyms — these names ARE legal per Twenty's `/^[a-z][a-zA-Z0-9]*$/` validation regex.
       >
       > Examples:
       > - `iOSDevice` → wrapper `i_osdevice`, server `i_o_s_device`
       > - `myURLToken` → wrapper `my_urltoken`, server `my_u_r_l_token`
       > - `appAPIKey` → wrapper `app_apikey`, server `app_a_p_i_key`
       >
       > Result: `search_records({object: 'iOSDevices'})` → "Tool `find_iosdevices` not found" (server registers `find_i_o_s_devices`). Same failure shape as #11.
       >
       > Plan's failure-mode #1 incorrectly claims "consecutive-capital object names are not producible" — `iOSDevice` IS producible (starts with lowercase). The fix likely converges with the pluralize-mass-noun follow-up: import `camelToSnakeCase` from `twenty-shared` AND fetch `namePlural` from metadata instead of inferring via pluralize.
       >
       > Mechanical repro: add `{singular: 'iOSDevice', plural: 'iOSDevices'}` to `CAMEL_CASE_INPUTS` in `crm-coverage.test.ts` — the existing equivalence assertion fails with a precise wrapper-vs-server output mismatch.

2. **Pluralize-mass-noun bug class (already flagged by the plan; auditor confirms this should be filed)** (packages/twenty-mcp/src/__tests__/crm.test.ts:57-65)
   - What: For object names containing English mass-noun stems (`analytics`, `data`, `metadata`, `news`, `series`, `mathematics`, `physics`, `statistics`, etc.), the wrapper's pluralize-based singular round-trip produces the wrong singular form. Example: `'companyAnalytics'` → snakeified `'company_analytics'` → `pluralize.singular('company_analytics')` = `'company_analytic'` (server expects `'company_analytics'` for both singular and plural). The `'search'` op happens to produce the correct name (pluralize.plural is a no-op on already-plural forms); `'get'/'create'/'update'/'delete'` produce the wrong name.
   - Why medium: identical failure shape and production impact profile to issue #11 — affected workspaces hit "Tool not found" on CRUD; the bug surfaces only for the subset of custom object names with mass-noun stems. The plan correctly defers this AND mechanically documents the broken behaviour in `crm.test.ts` "documents pluralize-mass-noun limitation" so the limitation is visible to future implementers. The plan explicitly invites the auditor to file this — auditor concurs.
   - Recommendation: yes, file as new GitHub issue (per the plan's "Out of scope" guidance). Draft:
     - **Title**: `twenty-mcp: CRM wrappers fail for object names containing English mass nouns (analytics, data, metadata, news, series, ...)`
     - **Body**:
       > Follow-up to #11. After the camelCase-boundary fix, the wrapper still produces wrong inner-tool names for object names whose stem is an English mass noun. The `pluralize` npm library mishandles these (it singularizes `analytics` → `analytic`, `news` → `new`, etc.), so the wrapper's `pluralize.singular(snakeified)` returns a non-existent name for CRUD ops.
       >
       > Concrete: `innerToolName('create', 'companyAnalytics')` = `'create_company_analytic'`; server registered tool is `'create_company_analytics'` (server uses `camelToSnakeCase` only — no singular/plural inference).
       >
       > Affected mass-noun stems (non-exhaustive): `analytics`, `data`, `metadata`, `news`, `series`, `mathematics`, `physics`, `statistics`, `economics`, `politics`, `species`, `means`.
       >
       > Mechanical visibility: `packages/twenty-mcp/src/__tests__/crm.test.ts` "documents pluralize-mass-noun limitation" asserts the actual (buggy) wrapper output for `companyAnalytics`.
       >
       > Proper fix is structural: the wrapper should fetch `nameSingular`/`namePlural` from server-side metadata via `metadata_query({kind:'objects'})` and use them directly with `camelToSnakeCase`, instead of inferring via pluralize. This converges with the embedded-acronym follow-up (both gaps disappear if the wrapper captures from the server).

### LOW

1. **Unused `pluralize` import in `crm-coverage.test.ts`** [TRIVIAL-IN-PLACE] (packages/twenty-mcp/src/__tests__/crm-coverage.test.ts:3)
   - What: `import pluralize from 'pluralize';` on line 3 is never referenced as code anywhere in the file (only mentioned in comments at lines 49, 51).
   - Why low: dead code; no functional impact (typecheck doesn't fail because tests are excluded from `tsc` in `tsconfig.json`; no eslint config to flag unused imports). Will land as committed warning-free.
   - Subcategory rationale: TRIVIAL-IN-PLACE — single-line deletion, no behaviour change, no test rewires. Cost to absorb: ~10 s. Cost of letting it land: confused future readers who think pluralize is being used here.
   - Suggested action: delete line 3 `import pluralize from 'pluralize';` from `packages/twenty-mcp/src/__tests__/crm-coverage.test.ts`; re-run `npx jest src/__tests__/crm-coverage.test.ts --config jest.config.ts` to confirm still green; estimated absorb time: 30 s.

2. **Plan's failure-mode #1 contains a factually wrong claim** [TRIVIAL-IN-PLACE] (packages/twenty-mcp/plans/issue-11-inner-tool-name-camelcase-boundary.md:396)
   - What: The plan's failure-mode #1 states "Twenty's auto-generated `nameSingular`/`namePlural` from `createOneObject` enforces camelCase-with-lowercase-first; consecutive-capital object names are not producible via the standard Twenty UI/API." This is partially true (the first letter must be lowercase) but incorrect about consecutive capitals — embedded acronyms like `iOSDevice`, `myURLToken` ARE permitted by the server's `/^[a-z][a-zA-Z0-9]*$/` regex. (See MEDIUM #1 above.)
   - Why low: the plan body is frozen historical record post-implementation; the supervisor typically appends `## Audit annotations` rather than editing the plan body. Marking this LOW because the wrong claim's *consequence* — the missing case in `CAMEL_CASE_INPUTS` — is captured by MEDIUM #1 above. The plan's text itself should be annotated for accuracy of the historical record.
   - Subcategory rationale: TRIVIAL-IN-PLACE — the supervisor's `/audit-fix` skill appends an annotation paragraph noting the corrected claim. NOT cross-cutting (it's specific to this plan's wording).
   - Suggested action: append an `## Audit annotations` paragraph to the plan noting "Failure-mode #1's claim 'consecutive-capital object names are not producible' is incorrect for lowercase-first names with embedded acronyms (e.g. `iOSDevice`). See follow-up issue [link from MEDIUM #1] for the bug class. The regex fix in this plan handles the common case correctly; the embedded-acronym case is filed as separate work." Estimated absorb time: 1 min.

3. **`crm-coverage.test.ts` uses a throw-on-missing pattern; the sibling `views-coverage.test.ts` uses `it.skip` on missing source** [COSMETIC] (packages/twenty-mcp/src/__tests__/crm-coverage.test.ts:21-26)
   - What: `views-coverage.test.ts:31` does `if (!existsSync(...)) { it.skip(...); return; }` — graceful skip when source moves. `crm-coverage.test.ts:21-26` throws unconditionally — hard failure when source moves.
   - Why low: both are defensible. The throwing pattern is slightly stricter (forces lockstep update); the skip pattern is more forgiving (CI doesn't fail if `twenty-shared` is restructured before the test path is updated). No correctness impact today.
   - Subcategory rationale: COSMETIC — pure style consistency. Could go either way; neither is wrong. Not a foot-gun (the throwing pattern has a clear actionable error message pointing at the constant to update).
   - Suggested action: backlog (cosmetic): consider standardizing on one pattern across `*-coverage.test.ts` files in twenty-mcp; resolution: append to `packages/twenty-mcp/plans/low-backlog.md` Queued table for the next sweep.

The supervisor (`/audit-fix` skill) routes per subcategory: trivial-in-place absorbed pre-commit (2 items); cosmetic appended to low-backlog (1 item).

## Adversarial pre-mortem (R3 against the diff)

1. **Agent creates a custom object named `iOSDevice` / `myAPIKey` / `appURLToken` (lowercase-first with embedded acronym)**. Wrapper resolves `find_iosdevices` / `find_my_apikeys` / `find_app_urltokens`, server registers `find_i_o_s_devices` / etc. CRUD wrappers fail with "Tool not found", same shape as the bug issue #11 ostensibly fixes. Filed as MEDIUM #1 above. Surfaces in the FIRST hour if any consumer creates such an object.

2. **Agent uses a `companyAnalytics`-pattern custom object (mass-noun stem).** CRUD wrappers fail for create/get/update/delete; search happens to work. Filed as MEDIUM #2 above. Already documented in the test suite for future implementers; needs a tracking issue for actual remediation.

3. **A future twenty-shared maintainer rewrites `camelToSnakeCase` in a way that diverges from the wrapper's regex but still matches the drift-gate signature regex (e.g. changes the lambda to handle consecutive capitals as a single boundary).** The signature regex would still pass; the equivalence assertions would catch single-boundary inputs but miss the corner case. The 10 curated inputs in `CAMEL_CASE_INPUTS` cover the common shape but provide no protection if the canonical algorithm changes its handling of edge cases the curated list doesn't exercise (this is documented as failure-mode #4 in the plan; mitigation is to add inputs to the list as new patterns become relevant). No defect introduced by the diff — the failure mode is pre-existing for any curated-input coverage approach.

## Recommendations to supervisor

- Block commit: **no**
- File new issues: **2** (MEDIUM #1 embedded-acronym camelCase, MEDIUM #2 pluralize-mass-noun)
- Annotate to plan / absorb pre-commit: **2 trivial-in-place LOWs** (unused pluralize import; plan failure-mode #1 correction annotation) + **1 cosmetic LOW** to low-backlog
- Confidence in this audit: **high**. All 10 mechanical gates ran (lint inconclusive due to pre-existing missing config, not a regression). Full unit suite + contract suite + live integration suite all green. Cleanup verified by independent direct GraphQL query. The two MEDIUM bugs are both reproducible from first principles by reading server validation rules + tracing the regex; the embedded-acronym one is a new finding the plan missed, the mass-noun one is one the plan invited the auditor to file.
