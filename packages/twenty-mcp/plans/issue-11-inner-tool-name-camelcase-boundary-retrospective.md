# Retrospective: fix innerToolName camelCase boundary loss (issue #11)

> Issue(s): #11
> Plan: packages/twenty-mcp/plans/issue-11-inner-tool-name-camelcase-boundary.md
> Audit cycles: 1
> Commit: 613026c16e
> Written: 2026-05-12T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Unit suite ~211 tests (171 existing + ~10 new in crm.test.ts + ~30 in crm-coverage.test.ts) | 205 / 205 passed. Slight count drift from the plan's 211 estimate (existing test count was 168, new additions: 7 in crm.test.ts + 30 in crm-coverage.test.ts) — count is mechanically correct; the prediction was approximate. |
| Contract test: 18 pass | 18 / 18 passed. As predicted. |
| Integration: 16 tests (10 pre-existing + 6 new) | 16 / 16 passed live against the running local stack. As predicted. |
| Cleanup: `mcpAuditFixture` absent after suite | Verified via direct `/metadata` GraphQL `objects(paging:{first:200})` query — zero matches. Cleanup worked. |
| Failure-mode #1: regex misses consecutive-capital boundary (`ABCFoo`). Mitigated by "consecutive-capital names not producible via Twenty UI" | **Partially wrong claim.** Server validation regex `/^[a-z][a-zA-Z0-9]*$/` permits any lowercase-first name including embedded acronyms (`iOSDevice`, `myURLToken`, `appAPIKey` — all producible). The plan's claim was correct for `ABCFoo` (rejected — starts with capital) but wrong for the broader case. Auditor flagged this as MEDIUM #1 and filed for follow-up. |
| Failure-mode #2: future `camelToSnakeCase` rewrite catches divergence via signature-regex gate + 30 equivalence assertions | Holds. Signature regex is specific enough to catch a meaningful rewrite; equivalence assertions cover the common camelCase shape. Residual gap (uncovered input patterns) is documented as failure-mode #4 honestly. |
| Failure-mode #3: leading/trailing whitespace + camelCase | Holds. `.trim()` runs first; verified by tracing `'  schemaChangeAudits  '` through. |
| Failure-mode #4: new camelCase pattern outside curated list silently diverges | Holds. Confirmed by auditor — embedded-acronym pattern (`iOSDevice`) is exactly this case. Filed as MEDIUM #1. |

## Audit journey

Round 1 (final): clean.

- All 10 mechanical gates ran: typecheck PASS, lint INCONCLUSIVE (pre-existing infra gap — no eslint config + `lint:diff-with-main` not configured for twenty-mcp; NOT introduced by this PR), full unit suite 205 / 205, contract suite 18 / 18, integration suite 16 / 16 live, stack health PASS, cleanup verified via independent direct GraphQL query, adjacent-callers check OK, R3-against-diff named three concrete failure modes (two filed as MEDIUMs, one no-defect).
- Zero critical, zero high defects → no block, proceed to retrospective.
- Two MEDIUM follow-ups drafted (embedded-acronym bug class; pluralize-mass-noun bug class).
- Two LOW trivial-in-place items (unused `pluralize` import in `crm-coverage.test.ts`; plan annotation correcting failure-mode #1's wording).
- One LOW cosmetic (sibling coverage tests use inconsistent missing-source patterns — `it.skip` vs throw).

## Defects routed but not blocking

- Filed as new issues (medium):
  - `twenty-mcp: CRM wrappers fail for camelCase object names with embedded acronyms (e.g. iOSDevice, myAPIKey)` — new finding, plan's failure-mode #1 incorrectly claimed this case was unreachable.
  - `twenty-mcp: CRM wrappers fail for object names containing English mass nouns (analytics, data, metadata, news, series, ...)` — plan's "Out of scope" explicitly invited filing this; mechanically documented in `crm.test.ts` "documents pluralize-mass-noun limitation".
- Annotated as low: 2 trivial-in-place items + 1 cosmetic; routed per `.claude/skills/audit-fix/SKILL.md` (absorb pre-commit / append to low-backlog).

## Surprises

1. **pluralize mass-noun mishandling, caught mid-implementation** (Supervisor R1): the plan's assertion `innerToolName('update', 'companyAnalytics') === 'update_company_analytics'` was wrong — `pluralize.singular('company_analytics')` returns `'company_analytic'`. This isn't a regression introduced by issue #11's fix; it's a pre-existing bug in the wrapper's pluralize-based inference that issue #11 didn't address. Supervisor revised by replacing `companyAnalytics` with `companyMetric` in the camelCase test AND adding a separate "documents pluralize-mass-noun limitation" test that pins the buggy output for `companyAnalytics`. The limitation is now mechanically visible. Bug class filed as MEDIUM follow-up by the auditor.

2. **`apply_plan` has no teardown ops** (Supervisor R2): the plan's integration test `beforeAll`/`afterAll` originally used `op: 'DELETE_OBJECT'` for fixture cleanup. `ApplyPlanOpKind` does NOT include any delete ops (build-up only — CREATE/UPDATE/UPSERT/REVOKE). TypeScript caught it at compile time. Supervisor replaced both call sites with direct `client.graphqlMutation('deleteOneObject', ...)` on `/metadata`. Side observation: the wrapper exposes no high-level "delete object" tool — a follow-up could add `metadata_delete_object`.

3. **`apply_plan` response is doubly nested** (Supervisor R3): the plan assumed `applied[0].result.id` was a flat lookup. Actually `applied[0].result` is itself an MCP `ToolsCallResult` (`{content: [{type:'text', text: '<JSON-string>'}], isError: false}`) — the created entity's id is at `JSON.parse(parsed.applied[0].result.content[0].text).id`. This nested-unwrap pattern is consistent across all apply_plan ops and would benefit from a helper; flagged as a follow-up consideration.

4. **Embedded-acronym camelCase divergence (NEW finding by auditor)**: the plan's failure-mode #1 stated "consecutive-capital object names are not producible via Twenty UI". Verification against `packages/twenty-server/src/engine/metadata-modules/flat-object-metadata/validators/utils/validate-flat-object-metadata-name.util.ts:14` (`/^[a-z][a-zA-Z0-9]*$/`) shows this is true only for the **first** character — embedded acronyms like `iOS` in `iOSDevice` ARE permitted. So names like `iOSDevice`, `myURLToken`, `appAPIKey` are reachable and produce wrapper-vs-server divergences. Filed as MEDIUM #1.

5. **`pluralize` import is unused in `crm-coverage.test.ts`**: imported on line 3, never referenced as code. Harmless (no eslint to flag, tests excluded from typecheck), but dead. Suggested for in-place absorb.

## Lessons for institutional memory

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L12 (proposed): When the wrapper transcribes any algorithm whose canonical implementation lives elsewhere, the "valid inputs" set is the canonical system's validation regex — NOT a vibe-check on "what users probably name things". Read the validation rule before claiming a class of inputs is unreachable. | `packages/twenty-mcp/CLAUDE.md` (Lessons table; specialisation of L1 "Capture; don't transcribe" applied to validation-rule reading) | The plan's failure-mode #1 went wrong because it asserted what UI conventions probably permit, rather than reading the server's validation regex. This is a wrapper-class generality, not Twenty-specific. |
| L13 (proposed): "Curated input list" coverage gates have a built-in residual risk: they catch wrapper-vs-wrapper-mirror drift but not silent divergence on inputs outside the curation. When the canonical algorithm is mechanical and short (one regex), prefer running it directly at test time against ALL inputs the wrapped system would accept — not against a hand-curated subset. | `packages/twenty-mcp/CLAUDE.md` (Lessons table) | The plan's `crm-coverage.test.ts` would catch embedded-acronym divergence IF such an input were in `CAMEL_CASE_INPUTS`. The lesson: if the canonical algorithm is one line, generate a property-test-style input set or import the canonical function and run direct equality. Documented as a residual risk in the plan honestly, but the structural solution is "capture, don't transcribe". |
| L14 (proposed): When the implementer's plan defers a bug class explicitly (e.g. "Out of scope: pluralize-mass-noun"), the auditor's job includes verifying the deferral is the *correct* deferral — i.e. the same investigation that surfaced the documented limitation should also surface any sibling limitations the plan didn't notice. Don't take "Out of scope" as a stop sign. | `.claude/agents/issue-auditor.md` or `packages/twenty-mcp/CLAUDE.md` (R6 audit checklist) | Auditor found the embedded-acronym bug class by re-running the same divergence analysis the plan applied to find the mass-noun case — but with attention to a different input pattern. Cheap to do; high value (one new MEDIUM filed). |
| (n/a) | The Supervisor R3 surprise about `apply_plan` response double-nesting is a one-off helper opportunity, not an institutional lesson — no ingrain needed unless a future plan hits the same shape and the cost of re-discovering it justifies a helper. | one-off |

The supervisor decides whether to wire these into CLAUDE.md or leave them for a future codification cycle.

## Diff summary

```
 ...r-tool-name-camelcase-boundary-audit-round-1.md | 115 ++++
 ...r-tool-name-camelcase-boundary-retrospective.md |  72 +++
 .../issue-11-inner-tool-name-camelcase-boundary.md | 597 +++++++++++++++++++++
 packages/twenty-mcp/plans/low-backlog.md           |   1 +
 .../twenty-mcp/src/__tests__/crm-coverage.test.ts  |  82 +++
 packages/twenty-mcp/src/__tests__/crm.test.ts      |  41 ++
 .../src/__tests__/integration/round-trip.test.ts   | 160 ++++++
 packages/twenty-mcp/src/tools/crm.ts               |  18 +-
 8 files changed, 1082 insertions(+), 4 deletions(-)
```

(Production code diff: 3 modified files at +303/-4 (`crm.ts`, `crm.test.ts`, `round-trip.test.ts`) + 1 new file (`crm-coverage.test.ts`). Plan, audit, retrospective, and low-backlog are metadata.)
