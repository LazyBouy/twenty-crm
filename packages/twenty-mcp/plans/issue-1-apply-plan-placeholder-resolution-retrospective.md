# Retrospective: metadata_apply_plan placeholder resolution

> Issue(s): #1
> Plan: packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution.md
> Audit cycles: 2 (round 1 BLOCKED on HIGH 1; round 2 CLEAN)
> Commit: pending — filled by closer post-commit
> Written: 2026-05-02T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Test plan: "placeholder resolved across GraphQL transport" — chained `CREATE_ROLE → UPSERT_OBJECT_PERMISSION` substituted via Shape 3 extractor | New unit test added in round 2 (`placeholder resolved across graphql transport: CREATE_ROLE id substituted into UPSERT_OBJECT_PERMISSION roleId`) — passes. Mock returns the bare `{ createOneRole: { id, ... } }` data object so the production `wrapGraphqlResult` path is exercised, not stubbed. |
| Test plan: "embedded placeholder passes through literally" — only whole-string `$<key>` substituted, embedded passed unchanged, no error fired | New unit test added in round 2 (`embedded placeholder passes through literally`) — passes. Asserts `viewId: "$k1"` → `'uuid-1'`, `description: "created via $k1"` unchanged, AND `result.isError === false`. |
| Test plan: original 3 round-1 tests (placeholder resolved, unresolved placeholder, skipped mutation) | All three still pass in round 2 — Shape 1 path (inner-tool) was not regressed by the Shape 3 walker addition. |
| Failure mode 1 (R3): skipped mutations pollute resolved map if handled carelessly | Mitigated correctly — `resumeSet.has(m.key)` skips the resolved-map population. Test `skipped mutation does not populate resolved map` mechanically enforces. |
| Failure mode 2 (R3): id-extraction silently misses a transport if shape enumeration is incomplete | **This is exactly what shipped in round 1** — Shape 3 was missed. Round 1 audit (HIGH 1) caught it; round 2 plan re-encoded the three shapes explicitly with worked examples; round 2 implementation walks Object.values(parsed.result) for the first nested object with a string `id`. Mechanically verified by the new unit test. The mitigation now holds. |
| Failure mode 3 (R3): partial-apply state after a failed placeholder substitution | Not changed by this fix — `apply_plan` is intentionally non-atomic; recovery is via `resumeFrom`. Description updated in round 1 to instruct `resumeFrom` on retry. Acceptable per the deferral. |

## Audit journey

**Round 1: BLOCKED.** Implementer added a two-shape id-extractor (`parsed.id ?? parsed.result.id`) and four unit tests. All round-1 tests passed (148/148 full suite). The auditor traced response shapes end-to-end through `twenty-mcp-client.ts:202` (`return json.data`) → `metadata.ts:267-270` (`wrapGraphqlResult` layers `{success, result: data}`) → id-extractor and identified that **the GraphQL transport's `result` is `{<mutationName>: {id, ...}}`, not `{id, ...}`**. The mutation name is an extra layer between `parsed.result` and `id`. Every `accessDispatchEntries` op (`CREATE_ROLE`, `UPDATE_ROLE`, `UPSERT_OBJECT_PERMISSION`, `UPSERT_FIELD_PERMISSION`, `INVITE_MEMBERS`, `CREATE_API_KEY`, `REVOKE_API_KEY`) silently failed to populate `resolved[m.key]`. Round-1 tests only exercised the inner-tool transport (`CREATE_VIEW`), so the defect shipped green — same `Tested-because-mock-passes` failure mode as bug #1 in this codebase's history.

The auditor also flagged three medium and two low defects (whole-string description gap, audit-trail resolved-args, `JSON.parse` size cap, broad catch comment, regex coupling). Mediums and lows did not block; HIGH 1 alone was sufficient to require revision.

**Round 2: CLEAN.** The plan was revised to re-encode the three concrete response shapes with worked examples and a Shape 3 walker pseudocode. The implementer replaced the two-shape extractor with a three-shape version using `for...of Object.values(r)` over `parsed.result`, plus added two new tests (`placeholder resolved across graphql transport` and `embedded placeholder passes through literally`). Description was extended with the whole-string-only sentence. Audit verified end-to-end: the test mock returns the bare `{createOneRole: {id, ...}}` shape (matching `client.graphqlMutation`'s real return value at twenty-mcp-client.ts:202), so the production `wrapGraphqlResult` is exercised. Type check passed; full suite 150/150 (148 baseline + 2 new). Three R3 failure modes named for future hardening but none exploitable on currently supported transports.

## Defects routed but not blocking

- **Filed as new issues (medium):** 0. The three round-1 mediums (whole-string description, audit-trail resolved-args, JSON.parse size cap) were folded into the round-2 plan's `## Out of scope` with explicit worst-case bug class per R2. MEDIUM 1 was substantively addressed in this round (description sentence + mechanical test).
- **Annotated as low:** 2 (LOW 1 catch-comment breadth, LOW 2 findUnresolved/error message regex coupling), recorded in the plan's `## Implementation notes → Audit annotations (round 1)`. LOW 1's broad-catch comment was rewritten in round 2 to explicitly document the swallow scope.

## Surprises

1. **GraphQL response shapes have THREE depths, not two.** The round-1 plan correctly identified that inner-tool and GraphQL transports return ids at different depths, but it encoded the wrong second shape (`{success, result: {id}}` instead of `{success, result: {<mutationName>: {id}}}`). The mutation name is an extra layer because `client.graphqlMutation` returns `json.data` directly (the GraphQL response's top-level object), and `wrapGraphqlResult` wraps that — it doesn't unwrap the mutation-name field. This is exactly the kind of detail that's invisible at the description level and visible only by tracing actual response payloads. (Round 1 R3-against-the-plan said "id-extraction must handle two shapes"; the right framing is "must handle as many shapes as transports return them at distinct depths".)

2. **`buildUpsertObjectPermissions` wraps args as `{input: args}` BEFORE `client.graphqlMutation`** (access.ts:170). The implementer's first draft of the round-2 GraphQL test asserted `secondCallVariables.roleId === 'role-uuid'` directly, which failed because the actual variables passed to `graphqlMutation` are `{input: {roleId, objectPermissions}}`. The placeholder substitution itself happens on `effectiveArgs` BEFORE `dispatch.build(effectiveArgs)` is called, so `effectiveArgs.roleId === 'role-uuid'` feeds correctly into `buildUpsertObjectPermissions`, which then wraps it. Test was corrected to assert `secondCallVariables.input.roleId`. This is correct production behaviour — the wrapper-vs-build distinction matters when writing assertions.

3. **`INVITE_MEMBERS` has no top-level id in its response** (`{ sendInvitations: { success, errors, result: [...] } }`). The Shape 3 walker correctly returns undefined for it (no top-level `id` on `sendInvitations`), so `resolved[<invite_key>]` is not set. Downstream `$<invite_key>` placeholders would error as "unresolved" — correct behaviour, since invitations don't return a single id that could be referenced. Not a defect, but a reminder that the resolved-map population is best-effort and not every CREATE op produces a placeholder target.

4. **The `Array.isArray` guard at line 564 is defensively useful**, even though no current GraphQL response has a top-level array under `parsed.result`. If a future mutation ever returned `parsed.result` as an array (e.g. `{success: true, result: [{id, ...}, {id, ...}]}`), the loop would otherwise descend into array indices — non-deterministic id selection. The guard keeps Shape 3 strictly object-valued.

5. **The lint pipeline is broken at the package level** (no `.oxlintrc.json`, no `lint:diff-with-main` Nx target). Confirmed pre-existing on the dev branch baseline; not introduced by this diff. Should be tracked as a separate tooling issue but is not blocking for this fix.

## Lessons for institutional memory

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| **L12: Wrapper response unwrapping must enumerate all transport shapes**, not just "one inner-tool shape and one GraphQL shape." When a wrapper extracts a structured field (id, status, error code, etc.) from a wrapped response, the path varies by transport. List every concrete transport this wrapper supports and the path-to-field for each, with a worked example payload for each. If the wrapper composes (e.g. `wrapGraphqlResult(json.data)`), the path-to-field is BOTH the wrap depth AND the underlying response depth — count the layers. | `packages/twenty-mcp/CLAUDE.md` — append to the **Lessons** table. The codebase already has 11 lessons rooted in transport-shape mistakes (L8, L9, L10 explicitly). This is a mechanical extension: "GraphQL mutation names ARE schema. Their position in the response is part of the schema too. Walk the actual payload, don't assume." | This codebase has shipped two bug classes from missing transport-shape enumeration: bug #4 (endpoint routing — `/metadata` vs `/graphql`) and now this round-1 bug (id-extraction depth — `parsed.result.id` vs `parsed.result.<mutationName>.id`). The lesson generalises to any wrapper that unwraps responses for downstream use; codifying it in `packages/twenty-mcp/CLAUDE.md` puts it in the same place future implementers look first. |
| **L13: For each new code path that walks a wrapped response, write a unit test whose mock returns the BARE wrapped-system response** (the same shape `client.<method>` actually returns), not a pre-wrapped envelope that mirrors what the wrapper produces internally. The test must exercise the wrapper's full unwrap chain, not stub it. | `packages/twenty-mcp/CLAUDE.md` — append to the **Lessons** table OR extend L2 ("Mocks pass when the spec passes — that's not correctness."). | This is a refinement of L2 / `Tested-because-mock-passes`. The round-1 inner-tool test correctly used the bare inner-tool response (`{id: "..."}`), but no test exercised the GraphQL transport. Round 2's GraphQL test correctly mocks `graphqlMutation` to return the bare data (`{createOneRole: {...}}`), which is what `client.graphqlMutation` actually returns at twenty-mcp-client.ts:202 — NOT `{success, result: {createOneRole: {...}}}` (which would have stubbed `wrapGraphqlResult` and let the bug ship green again). Codifying this prevents a slow regression. |
| **L14: Audit checklist — when a wrapper unwraps a response, enumerate transport shapes and trace each end-to-end.** Add to `.claude/skills/audit-fix/SKILL.md`'s checklist: "If the diff modifies a function that extracts a field from a wrapped response, enumerate every transport that flows through this code path. Trace each transport's actual response shape from the underlying client call (e.g. `client.graphqlMutation` → `json.data`) through every wrapper layer (e.g. `wrapGraphqlResult`) to the field being extracted. Confirm each transport is covered by a unit test whose mock returns the BARE underlying response, not a pre-wrapped envelope." | `.claude/skills/audit-fix/SKILL.md` — add a checkbox under the diff-reading section. | This is the audit-side counterpart to L12. The round-1 audit caught HIGH 1 because the auditor manually traced the full chain; this lesson ensures every future audit does so reflexively when an unwrap function is modified. |
| L15 (narrower follow-up — recorded but not ingrained): the Shape 3 walker uses insertion-order to pick the first nested object's id. Currently safe because Twenty's GraphQL responses have exactly one top-level mutation field. If a future mutation ever returns multiple, the placeholder would silently resolve to the wrong UUID. (n/a — too narrow to ingrain) | (no ingrain target) | Documented as R3 failure mode 1 in the audit-round-2 report; revisit if a multi-field GraphQL response is ever added. |

The supervisor decides which of L12–L14 to wire in. L12 is the most general and the highest-value to ingrain; L13 is a refinement of an existing lesson (L2) so could be folded there; L14 lives outside this package and crosses into the audit skill.

## Diff summary

```
 packages/twenty-mcp/src/__tests__/metadata.test.ts | 205 +++++++++++++++++++++
 packages/twenty-mcp/src/tools/metadata.ts          | 119 +++++++++++-
 2 files changed, 320 insertions(+), 4 deletions(-)
```

(`.gitignore` and `packages/twenty-mcp/CLAUDE.md` also appear in `git diff --name-only` but were dirty before this work began — confirmed in the initial git status; not touched in either round of this fix.)
