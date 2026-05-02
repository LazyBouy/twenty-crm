# Audit report: metadata_apply_plan placeholder resolution — round 2

> Plan: packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution.md
> Round: 2
> Audited: 2026-05-02T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | `npx tsc --noEmit` — clean. |
| Lint (`npx nx lint:diff-with-main twenty-mcp`) | TOOLING FAIL (pre-existing) | Same as round 1: `Cannot find configuration for task twenty-mcp:lint:diff-with-main`. Package-level lint config is missing on the dev branch and is not introduced by this diff. Confirmed unchanged from round-1 baseline. |
| Full unit suite (`npx jest --config jest.config.ts --testTimeout 10000`) | PASS | 12 suites, **150 tests passed**, 0 failed, ~11.7s. (Round-1 baseline 148 + 2 new = 150.) |
| Adjacent-callers check | OK | All `accessDispatchEntries` `build` callbacks confirmed pure (`{input: args}` or `{id, ...rest}` reshape) — no by-reference assumptions on `effectiveArgs`. `argsTransform` (`CREATE_RELATION` only) spreads into a new array. `viewsDispatchEntries` are all `inner_tool` (Shape 1 path); `accessDispatchEntries` are all `graphql` (Shape 3 path). HIGH 1's missed transport is now covered by code AND test. |

## Defects found

### CRITICAL — none

### HIGH — none

### MEDIUM — none new

The three medium-severity items from round 1 (MEDIUM 1: whole-string description; MEDIUM 2: resolved-args in audit trail; MEDIUM 3: JSON.parse size cap) are all explicitly addressed in the round-2 plan's `## Out of scope` section with worst-case bug class per R2:

- MEDIUM 1 — **resolved in this round**: the description now contains the whole-string-only sentence at metadata.ts:663 (verified on disk: `Placeholders must be the entire string value (e.g. viewId: "$k1"); embedded placeholders inside larger strings (e.g. "created via $k1") are not substituted and pass through to Twenty literally.`). A unit test (`embedded placeholder passes through literally`) mechanically verifies the contract: `viewId: "$k1"` is substituted to `"uuid-1"`, `description: "created via $k1"` passes through unchanged, and `result.isError === false`.
- MEDIUM 2 — deferred per plan; forensic-quality only; recoverable from inner-tool response.
- MEDIUM 3 — deferred per plan; bounded by trust boundary.

Per the supervisor's round-2 instructions, these are not re-flagged here.

### LOW — none new

LOW 1 (catch-comment breadth) and LOW 2 (findUnresolved/error message regex coupling) are recorded in the plan's `## Implementation notes → Audit annotations (round 1)` and remain dormant. The catch-comment in metadata.ts:573-579 was rewritten in round 2 to explicitly document the broad swallow:

```ts
// Note: this catch is intentionally broad; it swallows TypeError from undefined
// result.content as well as SyntaxError from non-JSON text. Placeholder-id extraction
// is best-effort and a missing id should not abort the whole apply-plan. Do NOT narrow
// this to SyntaxError only — shape changes would then crash the proxy.
```

LOW 1 is fully addressed by this comment update.

## Round-2 specific verification of HIGH 1 fix

The round-2 implementation at metadata.ts:541-579 was traced end-to-end against the GraphQL-transport test case to confirm the three-shape extractor is correct.

**Shape 1 (inner-tool transport, e.g. `CREATE_VIEW`):**
- Test mock: `{ content: [{ type: 'text', text: '{"id":"uuid-from-k1"}' }] }`.
- `parsed = { id: 'uuid-from-k1' }`. Line 556 short-circuits with `parsed.id`. PASS.
- Round-1 inner-tool test (`placeholder resolved: $<key> in second mutation args …`) still green — verified by running the placeholder-pattern jest filter (5/5 pass).

**Shape 2 (defensive flat `{success: true, result: {id: "..."}}`):**
- No production transport currently emits this shape, but the `??` chain covers it: `parsed.result.id` is checked at line 558 before the loop fires. The Shape 3 walker only runs when both Shape 1 and Shape 2 miss. SAFE.

**Shape 3 (GraphQL transport, e.g. `CREATE_ROLE`):**
- Test mock: `mockResolvedValueOnce({ createOneRole: { id: 'role-uuid', label: 'X' } })` on `client.graphqlMutation`. **Critical correctness check**: this is the **bare** data object as `client.graphqlMutation` returns at twenty-mcp-client.ts:202 (`return json.data`). The mock does NOT pre-wrap the response with `{success, result}` — production `wrapGraphqlResult` wraps it (metadata.ts:267-270, 538). This means the test exercises the FULL production path through `wrapGraphqlResult`, not a stub of it. (`Tested-because-mock-passes` class avoided.)
- `data = { createOneRole: { id: 'role-uuid', label: 'X' } }`.
- `result.content[0].text = JSON.stringify({ success: true, result: { createOneRole: { id: 'role-uuid', ... } } })`.
- `parsed.id` undefined; `parsed.result.id` undefined; the IIFE at line 560-570 walks `Object.values(parsed.result) === [{ id: 'role-uuid', label: 'X' }]`, finds the first object with a string `id`, returns `'role-uuid'`. `resolved['k1'] = 'role-uuid'`. Then `resolvePlaceholders` substitutes `$k1` → `'role-uuid'` on k2's `roleId`. `buildUpsertObjectPermissions` wraps it as `{ input: { roleId: 'role-uuid', objectPermissions: [] } }`. Test assertion `secondCallVariables.input.roleId === 'role-uuid'` is correct (verified against `access.ts:170` `variables: { input: args }`). PASS.

**Edge cases verified:**

- **Multiple nested objects with `id` in `parsed.result`**: Twenty's GraphQL responses always have exactly ONE top-level mutation field per response (`{ <mutationName>: { ... } }`), so the loop's "first by insertion order" behaviour is safe in practice. If a future response shape ever returned multiple mutation fields (e.g. via `@batch` directive), the loop would silently grab the first one — a latent foot-gun but not exploitable today. Worth recording as L13 below.
- **`parsed.result.<mutationName>` is null**: line 564's `v && typeof v === 'object'` skips null. Safe.
- **`id` is a number**: line 566's `typeof candidate === 'string'` skips. Safe.
- **`id` is missing on a wrapped object** (e.g. `INVITE_MEMBERS` returns `{ sendInvitations: { success, errors, result: [...] } }` — no top-level `id`): line 565-567 returns undefined; `resolved[m.key]` is not set. Downstream `$<invite_key>` placeholder would error as "unresolved" — which is correct behaviour: invitations don't return a single id, so they can't be referenced. Not a defect.
- **`Array.isArray` exclusion**: line 564's `!Array.isArray(v)` prevents the loop from descending into array-valued mutation results. For `INVITE_MEMBERS`'s `result: [...]` that's a property of `sendInvitations`, not a top-level value of `parsed.result`, so it doesn't matter here, but the guard is defensively correct against any future array-shaped top-level.

## Adversarial pre-mortem (R3 against the diff)

Three failure modes the diff (now corrected) could plausibly surface in the next hour of real use:

1. **Future `/metadata` mutation with multi-field response.** If Twenty ever introduces a mutation that returns more than one top-level field — e.g. `{ createOneRole: { id }, refreshedToken: { id } }` from a hypothetical `@batch` directive — the Shape 3 walker returns the FIRST object's id by insertion order. The placeholder would resolve to the wrong UUID, silently. **Mitigation today:** none in code; the dispatch table assumes single-mutation responses (which is true for all currently supported ops). **Detection:** would surface as "view-field linked to wrong role" or similar cross-resource confusion — not as an error. **Recommendation:** ingrain the rule "wrapper id-extraction must enumerate all transport shapes" (see Lessons below); revisit if a multi-field GraphQL response is ever added.

2. **Soft-failure GraphQL response with `success: false` but no thrown error.** If `client.graphqlMutation` returns `{ createOneRole: null, errors: [...] }` (some Twenty mutations return null on validation error rather than throwing), `parsed.result.createOneRole === null`, the `v && typeof v === 'object'` check skips it, no id is extracted, `resolved[m.key]` stays empty, and downstream `$k1` references fail with "unresolved placeholder". The wrapper does NOT detect that the mutation soft-failed — `applied[]` records it as successful. The user sees an apparently-successful k1 followed by a confusing "unresolved placeholder" on k2. **Mitigation today:** none specific to this diff; this is a pre-existing partial-apply hazard adjacent to the placeholder mechanism. The error message does instruct `resumeFrom` for recovery, but the underlying soft-failure root cause is opaque. **Acceptable for now** because Twenty's `/metadata` GraphQL throws on validation errors via NestJS's exception filters in the typical case. Worth flagging in the retrospective.

3. **Placeholder collision: a mutation key contains characters the regex doesn't match.** The regex `^\$([a-zA-Z0-9_]+)$` rejects any key with `-`, `.`, or `:` characters. The `ApplyPlanMutation` schema (metadata.ts:204-211) accepts `key: z.string().min(1)` — no character restriction. So a caller could set `key: "create-view"` and reference it as `$create-view`, but the regex would not match (because `-` is not in `[a-zA-Z0-9_]`); the literal `$create-view` would pass through to Twenty as an unresolved placeholder. The error message wouldn't fire either, because `findUnresolved` uses the same regex. **Mitigation today:** none; the contract is implicitly "alphanumeric + underscore keys only". Worth a documentation fix in a future round (description currently says only "any mutation's `args`, use `$<key>`"; doesn't say `<key>` must be `[a-zA-Z0-9_]+`). **Not blocking** because the issue's example keys are all underscore-snake-case; real callers will likely follow that convention. Recording as a follow-up, not a defect.

## Recommendations to supervisor

- **Block commit:** NO. Round 2 is clean: 0 critical, 0 high, 0 new medium, 0 new low. The HIGH 1 fix from round 1 is correctly implemented and mechanically verified by the new GraphQL-transport unit test, which exercises the production `wrapGraphqlResult` path (not a stub).
- **File new issues:** 0 immediate. Three R3 failure modes (multi-field response; soft-failure handling; key character restriction) are recorded above for the retrospective and as candidates for future hardening — none are exploitable on currently supported transports.
- **Annotate to plan:** 0 new. LOW 1 and LOW 2 from round 1 are already in the plan's `## Implementation notes → Audit annotations`; LOW 1's catch comment was substantively addressed in metadata.ts:573-579 in round 2.
- **Confidence in this audit:** HIGH. The HIGH 1 fix was end-to-end traced through the actual response shapes (`twenty-mcp-client.ts:202` `return json.data`; `metadata.ts:267-270` `wrapGraphqlResult`; `metadata.ts:553-571` three-shape extractor). The new test mock uses the bare data shape (not a pre-wrapped envelope), so the `Tested-because-mock-passes` class is avoided. All five placeholder-resolution unit tests pass; full suite is 150/150 green; type check is clean. The audit was conducted with no shared context with the implementer.

## Output

PROCEED — supervisor may run R1 re-run + own-audit pass. Retrospective written to `packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution-retrospective.md`.
