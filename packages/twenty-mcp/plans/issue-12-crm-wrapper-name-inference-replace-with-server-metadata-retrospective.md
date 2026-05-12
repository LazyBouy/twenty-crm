# Retrospective: Replace wrapper name inference with server-side metadata fetch

> Issue(s): #12 (grouped: #13)
> Plan: packages/twenty-mcp/plans/issue-12-crm-wrapper-name-inference-replace-with-server-metadata.md
> Audit cycles: 1 (final clean pass)
> Commit: pending — filled by closer post-commit
> Written: 2026-05-12T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Test plan item 1 — Dependency check (`twenty-shared` added to `package.json`) | DONE — `twenty-shared: "workspace:*"` added. `yarn install` exited non-zero due to Node v22 post-install validation (engines requires v24.5), but the workspace symlink resolution succeeded; no impact on typecheck/tests. The actual import from `'twenty-shared/utils'` was abandoned because `twenty-shared` had no compiled `dist/` at impl time (auditor confirmed: `dist/` is built only when `nx lint`'s dependency chain rebuilds `twenty-shared`, which is not part of the `twenty-mcp` test or typecheck targets). Local re-definition of `camelToSnakeCase` shipped instead — byte-identical to `twenty-shared`'s source. |
| Test plan item 2-5 — Unit suite (crm.test, crm-coverage.test, contract.test, wire-level) | DONE — 29 + 25 + 18 + 16-skipped/13-passed; full suite 212 passing across 16 suites. Auditor confirmed by re-running. |
| Test plan item 6 — Typecheck | DONE — `npx nx typecheck twenty-mcp` returns 0 errors. Auditor confirmed. |
| Test plan item 7-8 — Contract + SDK boundary | DONE — 18/18 contract; 2/2 sdk-boundary. Auditor confirmed. |
| Test plan item 9-11 — Live integration (embedded-acronym, mass-noun, full round-trip) | DONE — 27/27 passing against `localhost:4440` + `localhost:4441` stack. Auditor re-ran all 27 tests in this audit pass; all green. |
| Test plan item 12 — Manual curl against live proxy at localhost:4441 | DEFERRED — proxy container `twenty-local-mcp-1` runs a pre-built `twenty-mcp:local` image that does NOT include the source changes. Auditor confirmed via `docker ps` (container 3h old). Integration tests bypass the proxy by importing source directly, so the fix IS verified end-to-end against the live Twenty stack. The proxy needs `docker compose build mcp && docker compose up -d mcp` to ship the fix to the running container. This is a deployment-loop step, not a code defect. Tracked as LOW (foot-gun) in the audit. |
| Failure-mode #1 hypothesis: metadata fetch adds latency | HELD — one extra round-trip per CRUD call (~5-20 ms on local stack). Inline `TODO: add in-process TTL cache` comment in place at `crm.ts:68`. Auditor verified there is no accidental double-fetch: exactly 2 `toolsCall` sites in `crm.ts` (one in `resolveObjectNames`, one in `wrapInExecute`). |
| Failure-mode #2 hypothesis: ambiguous lowercase-stripped forms (e.g. `myAPIKey` + `myApiKey`) | HELD with caveats — the implementation correctly throws an ambiguity error when two objects collide under lowercase comparison. However: (a) the doc-comment claim "Preference order: exact case-sensitive match first" is NOT implemented (no case-sensitive pre-pass); (b) the implementer's surprise-note rationale for substituting `{myAPIKey, myApiKey}` with `{testObject, testobject}` was based on a misdiagnosis of the matching algorithm — the original fixture would have ambiguated correctly. Both are LOW (one TRIVIAL-IN-PLACE doc-comment edit, one COSMETIC backlog entry). |
| Failure-mode #3 hypothesis: metadata fetch failure surfaces as confusing error | HELD — `resolveObjectNames` wraps the fetch in try/catch and re-throws with a structured `"Failed to fetch object metadata for resolving '${input}': ${err.message}. Verify the MCP server can reach Twenty."` message. Tested in `crm-coverage.test.ts:263-271`. |

## Audit journey

Round 1 (final): clean — zero critical, zero high defects. One MEDIUM (L1 violation: hand-authored `get_object_metadata` fixture entry diverges from server source AND is not included in `capture-inner-schemas.ts`'s `STATIC_INNER_TOOL_NAMES`, so it won't auto-refresh on re-capture). One TRIVIAL-IN-PLACE LOW (doc-comment lie). Three backlog LOWs (cosmetic surprise-note correction; foot-gun deployment-loop reminder; foot-gun local `camelToSnakeCase` drift hazard). Live integration suite confirmed end-to-end correctness against `localhost:4440` Twenty stack.

## Defects routed but not blocking

- Filed as new issues (medium): **1** — title: `twenty-mcp: refresh hand-authored get_object_metadata fixture entry via capture script (L1 violation)`. Body drafted in the audit-round-1 report's MEDIUM section.
- Annotated as low: **4** total — 1 TRIVIAL-IN-PLACE (doc-comment edit), 1 COSMETIC (plan-annotation), 2 FOOT-GUN (deployment-loop reminder + local-copy drift hazard). Routing per the supervisor's `/audit-fix` skill: trivial-in-place absorbed pre-commit; cosmetic + foot-guns appended to `packages/twenty-mcp/plans/low-backlog.md` Queued table.

## Surprises

(consolidated from the plan's Implementation notes + audit findings — all small but worth surfacing for institutional memory)

1. **The plan's `client.toolsCall('metadata_query', {kind:'objects'})` is not a real call at the MCP boundary.** `metadata_query` is a TOOL the proxy exposes to agents; `client.toolsCall(...)` routes to Twenty's `/mcp` endpoint, which does NOT have a `metadata_query` tool. The correct inner tool is `execute_tool({toolName: 'get_object_metadata'})`. The implementer correctly identified this and routed directly. Confirmed against `packages/twenty-mcp/src/tools/metadata.ts:283` (`QUERY_ROUTES.objects → innerToolName: 'get_object_metadata'`).

2. **`twenty-shared` has no compiled `dist/` until something triggers its build.** This blocked the plan's `import { camelToSnakeCase } from 'twenty-shared/utils'`. Auditor verified `dist/` IS built by the `nx lint` dependency chain (`twenty-shared:build` runs before `twenty-mcp:lint`), but the `twenty-mcp:typecheck` and `twenty-mcp:test` targets do NOT depend on `twenty-shared:build`. This is a structural quirk of the Nx target graph: the typecheck/test cycles assume `twenty-shared` is already built or rely on TS path mappings rather than the runtime ESM resolution. The implementer's local-copy workaround is correct given this constraint; the proper long-term fix is either (a) add `twenty-shared:build` as a dependency of `twenty-mcp:typecheck`/`test`, or (b) replace the local copy with the import once `dist/` is reliably present in CI.

3. **`yarn install` exits non-zero on Node v22 due to engines validation.** The repo's `package.json` engines field requires `node ^24.5.0`; the auditor's environment runs v22.16.0. `yarn install` fails the post-install validation step but resolution itself succeeded — symlinks for workspace packages are correctly in place. All gates (typecheck, jest, integration tests) ran without issue. Documenting because the next implementer or auditor on a v22 system may see the same exit code and worry; it's safe.

4. **Ambiguity test fixture switched from `{myAPIKey, myApiKey}` to `{testObject, testobject}`.** Both correctly exercise the ambiguity safety net. The implementer's rationale (the camelToSnakeCase forms differ, hence no ambiguity) misdiagnosed the matching algorithm — the resolver compares lowercased forms, so `myAPIKey.toLowerCase() === myApiKey.toLowerCase() === 'myapikey'` WOULD have produced ambiguity. The substitute fixture works correctly anyway. Lesson: when an implementer reports "the plan's fixture didn't work and I substituted X", verify the diagnosis as well as the substitute.

5. **`coverage.test.ts` enforces inner-tool-name fixture presence.** Adding a new `toolName: '<X>'` literal to ANY file in `src/tools/` triggers a fixture lookup. The implementer correctly added a `get_object_metadata` entry but hand-authored its description/schema rather than capturing from the live server. The auditor flagged this as the round's only MEDIUM (L1 violation).

6. **`contract.test.ts` stub needed a metadata-fetch branch.** The previous stub returned `'ok'` for all `toolsCall` invocations, which broke once `resolveObjectNames` started parsing the response as JSON. The implementer correctly added a `if (args.toolName === 'get_object_metadata') return metadataFixture` branch. The `lastInner()` accessor correctly excludes the metadata call because the metadata branch returns early without setting `inner`. All 18 contract tests still pass.

7. **Test plan numbering discrepancy.** The plan's `## Test plan` section was authored as 10 items but enumerates 12 distinct verification steps (dependency check + 2 unit items + 1 wire-level + 1 full suite + typecheck + contract + sdk-boundary + 2 integration + 1 full integration + 1 manual). The implementer's Implementation notes correctly enumerated all 12. Item 12 (manual curl against the live proxy) is the only one deferred.

8. **Performance: one extra round-trip per CRUD call is structural.** The plan acknowledged this explicitly. Auditor verified the implementer added an inline `TODO: add in-process TTL cache` comment but did NOT introduce additional metadata fetches (e.g., one per test assertion). For an LLM agent issuing N CRUD calls in a session, the cumulative latency is N × metadata-fetch-cost on top of the actual CRUD cost. Acceptable tradeoff for correctness; cache can be added as a follow-up.

## Lessons for institutional memory

For each lesson, propose where it should ingrain. The supervisor decides whether to wire it in — auditor only proposes.

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L1+: When a wrapper adds a new inner-tool name AND triggers the `coverage.test.ts` fixture-presence check, the implementer MUST add the name to `capture-inner-schemas.ts`'s `STATIC_INNER_TOOL_NAMES` so the entry is refreshable. Hand-authoring the schema once and forgetting to wire the capture script means the fixture entry becomes a stale lie. | `packages/twenty-mcp/CLAUDE.md` (Before-shipping checklist, under "Mechanical gates") | This is a refinement of L1 ("capture, don't transcribe") specific to this package's structure. Two consecutive plans (#11 supervisor, #12 implementer) have added fixture entries; only one (the implementer of #12) had to hand-author one to clear the gate. Now that the pattern is known, it should be in the checklist: "If a new `toolName: '<X>'` literal is introduced, add `'X'` to `STATIC_INNER_TOOL_NAMES` AND re-run the capture script — do NOT hand-author the entry." |
| L1.5: When the implementer reports a "plan deviation" with a stated rationale, the auditor must verify the rationale, not just the outcome. The fixture substitution in issue #12 was correct (functionally), but the reasoning was based on a misdiagnosis of the resolver's matching algorithm. Future R3 / R6 work needs to scrutinize "I changed X because Y" claims with the same rigour as "I implemented X" claims. | `packages/twenty-mcp/CLAUDE.md` (Evaluation rules — R6) | R6 currently says "an actor distinct from the implementer audits the diff." This refinement says: "...AND verifies the implementer's stated rationale for any deviation from the plan, not just the resulting code." Bug class: an implementer might fix the symptom but misdiagnose the cause, which sets a bad precedent for future changes. |
| L11+: When a wrapper change requires a Docker image rebuild to surface at the user-facing endpoint, the deployment-loop step (`docker compose build <svc> && docker compose up -d <svc>`) MUST be explicitly flagged in the plan's Implementation notes (or the supervisor's pre-commit checklist) — NOT left as an implicit "the user will rebuild." The integration tests bypassing the proxy by direct source-import means the source IS verified, but the running endpoint is stale until rebuild. A user who tests via the running endpoint after commit but before rebuild sees the OLD bug and may misreport the fix as failed. | `packages/twenty-mcp/CLAUDE.md` (Deployment loop section, add a "When source changes require image rebuild" subsection) | The current Deployment loop section says "LOCAL → bring up local Twenty → full sweep on .env.local → fix bugs locally → all green → docker compose build mcp → ship to VPS." That's correct, but it's positioned as VPS-deployment. The new lesson is that EVEN FOR LOCAL TESTING via the proxy at `localhost:4441`, the rebuild step is needed if the user wants to validate via curl/MCP-client rather than via direct source-import tests. Make the rebuild-after-source-change requirement loud. |
| L1++: Drift between a local re-implementation and a canonical algorithm should have a mechanical drift gate, not just a doc comment. The local `camelToSnakeCase` in `crm.ts` is byte-identical to `twenty-shared`'s today; the comment promises this but no test enforces it. A one-file test that imports from `twenty-shared/utils` (when available) and asserts equivalence on a curated input list closes the foot-gun. | `packages/twenty-mcp/CLAUDE.md` (Lessons table) | This is a specialization of L1. Worth recording because it's the exact failure mode the L1 lesson was created to prevent, and we shipped a deferred-import that re-creates it (with mitigation: byte-identical today). Future plans that introduce similar local re-implementations should propose the drift gate as part of the plan, not as a post-hoc audit finding. |
| (n/a) | (no ingrain — too narrow / one-off) | The Node v22 vs engines-v24.5 yarn install non-zero exit is a development-environment quirk, not a code lesson. Already documented in CLAUDE.md's toolchain section. |

## Diff summary

```
 packages/twenty-mcp/package.json                                   |   1 +
 packages/twenty-mcp/src/__tests__/contract.test.ts                 |  19 ++
 packages/twenty-mcp/src/__tests__/crm-coverage.test.ts             | 338 ++++++++++++++++-----
 packages/twenty-mcp/src/__tests__/crm.test.ts                      | 292 ++++++++++++++----
 packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json |  37 ++-
 packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts   | 287 ++++++++++++++++-
 packages/twenty-mcp/src/tools/crm.ts                               | 190 +++++++++---
 yarn.lock                                                          |   4 +
 8 files changed, ~1168 insertions(+), ~201 deletions(-)
```
