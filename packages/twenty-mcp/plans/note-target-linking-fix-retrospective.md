# Retrospective: note-target linking via GraphQL bypass

Companion to [note-target-linking-fix.md](./note-target-linking-fix.md). What blocked Phase E, what the symptom misled us about, and the reusable lesson.

## What happened

Phase E workflows tried to attach evaluation Notes to Companies via Twenty's `noteTarget` join object. Every attempt — whether via `create_record({object: "noteTarget", …})` or `create_record({object: "timelineActivity", …})` — failed with:

> Object cannot be created by workflow

The API key was admin (`canUpdateAllSettings`, `canReadAllObjectRecords`, the works). Permissions weren't the problem. The team applied a workaround (embed `companyId` in the note body, find by title search), shipping a degraded CEO experience: Notes lived in search results instead of the Company's "Notes" tab.

## What the symptom misled us about

The error message says "by workflow" — that primed the team to think this was about role flags, workflow-actor classifications, or something agentic-grounds-1's role lacked. Hours of investigation into roles and `canBeAssignedToApiKeys` flags would have found nothing, because **none of those flags are consulted by the gate that actually fired.**

## Root cause (verified by source-reading, not log diving)

Three facts compound to produce the bug:

1. **Twenty's record-crud path hardcodes the actor source to `WORKFLOW`** for every create call, regardless of whether the request came from an API key, a user, or an actual workflow. Source: [`CreateRecordService:54-57`](../../twenty-server/src/engine/core-modules/record-crud/services/create-record.service.ts#L54-L57). The auth context carries `type: 'apiKey'` but never reaches the actor metadata.

2. **The gate `canObjectBeManagedByWorkflow` rejects every `isSystem: true` object** ([`canObjectBeManagedByWorkflow.ts`](../../twenty-shared/src/workflow/utils/canObjectBeManagedByWorkflow.ts)). It doesn't check actor type, role, or permission — purely a structural property of the object metadata. `noteTarget` and `timelineActivity` are both `isSystem: true`.

3. **The error message `Object cannot be created by workflow`** is technically true (the gate is named after workflow management) but misleading — it implies a workflow-vs-non-workflow distinction that the gate doesn't actually make. The gate would reject a USER call too if it ever reached this path with a system object.

So: every record-crud create from any caller, of any system object, is blocked. With the actor source pinned to WORKFLOW upstream, the error message even reads like a workflow-specific rule. It isn't.

## The breakthrough nobody could have predicted from the error message

**The GraphQL `createOne<Object>` resolver doesn't go through `CreateRecordService` at all.** It calls `CommonCreateOneQueryRunnerService.execute` directly ([`create-one-resolver.factory.ts`](../../twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts)), and that runner has zero workflow/system gates. So `mutation { createNoteTarget(data: {…}) }` works fine for the same agentic-grounds-1 API key that was being rejected by the record-crud route.

This means the workspace had two parallel write paths the whole time, with different gating rules, and we'd been routing through the gated one without realising the ungated one existed.

## The fix

Add a typed wrapper `link_note_to_record` in [packages/twenty-mcp/src/tools/note-targets.ts](../src/tools/note-targets.ts) that builds a `createNoteTarget(data: {…})` GraphQL mutation and forwards it via `client.graphqlMutation`. Same pattern already used by [access.ts](../src/tools/access.ts) for resolvers Twenty doesn't expose as inner tools.

- No upstream patch.
- No fork of the `twentycrm/twenty:latest` image.
- No role / permission changes.
- The MCP wrapper layer absorbs the routing complexity; agents see one tool with a simple signature.

The fix is in plain CRM-default territory (registered always, not gated behind `enableMetadata`) because note-record linking is a baseline Phase E need.

## Lessons (apply to every wrapper / proxy / adapter we build)

### L1. Error messages name the gate, not the cause.
`Object cannot be created by workflow` is the gate's identity, not a diagnostic of why the call was refused. When an error message implies a category (workflow, role, permission), verify by reading the gate's source — don't assume the message describes the rule. The gate here doesn't even consult actor type.

### L2. Symmetric-looking systems often have asymmetric internals.
"Twenty has a write path" is wrong. **Twenty has multiple write paths** — record-crud (gated), GraphQL `createOne` (ungated), workflow runner (different gates again), direct ORM (no gates). Wrapper layers must know which path they're on, and which gates exist on each. The MCP/tool path runs through `CreateRecordService`; the GraphQL path doesn't. Two different stories, one CRM.

### L3. Hardcoded defaults eat caller context silently.
`params.createdBy ?? { source: 'WORKFLOW' }` looks innocuous but throws away the entire authContext. When an upstream layer carries information (`type: 'apiKey'`) that a downstream layer needs (`actor.source`), the connecting code must thread it through. Fallback-to-default patterns should fall back to *neutral* values (e.g., `UNKNOWN`), not to a *specific* one (`WORKFLOW`) — a neutral default is a question, a specific default is a lie.

### L4. The first investigation hypothesis is shaped by the error vocabulary.
"By workflow" → "must be a workflow/role/permission issue." Wrong vocabulary leads to hours of fruitless search. When the obvious-from-the-message hypothesis doesn't pan out, jump immediately to source-reading the gate's predicate, not to deeper permission digging.

### L5. Test the unhappy paths a wrapper hides from agents.
Our contract tests covered shape correctness for the happy path of every wrapper. They didn't have a case for "this object is a system object — does the wrapper choose the right transport?" That's exactly the kind of routing decision agents can't introspect, so the wrapper has to be tested for it. Now `note-targets.test.ts` asserts the wrapper *never* uses `toolsCall` — the absence-of-an-action invariant is the test.

### L6. Workarounds erode trust in the abstraction.
The "embed companyId in note body" workaround works mechanically but trains agents (and humans) to distrust the CRM's own relational model. Once that trust is eroded, agents start storing structured data in unstructured fields everywhere, defeating the purpose of having a CRM. Wrapper bugs that force workarounds compound the cost over the life of the deployment.

## Process changes implemented in this fix

- **New tool `link_note_to_record`** ([`src/tools/note-targets.ts`](../src/tools/note-targets.ts)) — typed wrapper around the GraphQL bypass.
- **Unit tests** ([`src/__tests__/note-targets.test.ts`](../src/__tests__/note-targets.test.ts)) — schema validation, mutation shape, and **the routing invariant** (handler must NOT use the `toolsCall` path).
- **Contract test case** added to [`src/__tests__/contract.test.ts`](../src/__tests__/contract.test.ts) — verifies the GraphQL variables payload conforms to the fixture schema (`createNoteTarget`) and that `lastInner()` is never called.
- **Fixture entry** for `createNoteTarget` added to [`inner-tool-schemas.json`](../src/__tests__/fixtures/inner-tool-schemas.json) — captures the data shape (`data.{noteId, targetCompanyId, targetPersonId, targetOpportunityId}`) for ajv validation.
- **Integration round-trip** extended in [`src/__tests__/integration/round-trip.test.ts`](../src/__tests__/integration/round-trip.test.ts) — gated by `TWENTY_MCP_INTEGRATION=1`, runs create company → create note → link → verify.
- **Tool registered always** (not gated behind `enableMetadata`) since note-linking is baseline functionality.

## What we did not change (and why)

- **Did not patch twenty-server.** The architecturally correct fix (derive actor source from authContext, relax `canObjectBeManagedByWorkflow` for non-WORKFLOW sources) requires a fork + ongoing rebuild on every Twenty version bump. The MCP-layer fix achieves the same user outcome at a fraction of the maintenance cost. The upstream PR is a proper follow-up, not a blocker.
- **Did not add `link_timeline_activity`.** Same gate problem, same GraphQL bypass would work, but timeline activities are usually auto-created by Twenty's services. Add only when there's a concrete agent need.
- **Did not build a generic `system_object_create`.** That would let agents bypass `isSystem` for every system object including the ones Twenty intentionally protects. We added one specific bypass for one specific use case. Discretion preserved.

## Open follow-ups

1. **Upstream PR to Twenty** — derive actor source from `authContext` in `CreateRecordService`; relax the gate to permit `API` and `SYSTEM` sources to create system objects (workflows still blocked, which is the original intent). The earlier root-cause analysis has the patch sketch.
2. **Audit other `isSystem: true` objects** — grep `isSystem: true` in Twenty's standard objects. Likely candidates: `attachment`, `comment`, `favorite`. If any is a real agent need, port the GraphQL-bypass pattern.
3. **Discovery hint** — when an agent calls `create_record({object: "noteTarget", …})`, the proxy could detect this and surface a friendly redirect to `link_note_to_record` instead of letting the call fail with the cryptic `cannot be created by workflow` message.
4. **Refactor the routing decision** — long-term, every CRUD operation in `crm.ts` could check object metadata at startup, decide whether to route via `execute_tool` or GraphQL, and hide the choice from agents entirely. For now, the explicit `link_note_to_record` is clearer.

## TL;DR for the next contributor

1. **Don't trust an error message to describe the rule.** Read the gate's predicate.
2. **Wrappers see one transport; the wrapped system has many.** Know which transport you're on and what gates each transport carries.
3. **Hardcoded fallbacks are silent context loss.** If you must default, default to neutral, not to a specific value.
4. **Test routing decisions with absence assertions.** "This handler MUST NOT call X" is a real test, and it's what catches wrong-path bugs.

---

## Addendum (next day): the GraphQL mutation name was also hand-authored, and also wrong

After this fix shipped, the user reported that `createOneNoteTarget` doesn't exist in their Twenty version's GraphQL schema — the actual mutation is `createNoteTarget` (no `One` prefix). One-line fix applied. This is the **same class of bug as the one this retrospective was written about**, surfacing again less than 24 hours later.

### How

The original fix's reasoning chain:
1. Read [access.ts](../src/tools/access.ts) — uses `createOneRole`, `updateOneRole`. ✓
2. Read [`create-one-resolver.factory.ts`](../../twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts) — the resolver factory is `CreateOneResolverFactory`, registered under method-key `'createOne'`. ✓
3. **Inferred** (didn't verify): every object exposes a `createOne<Object>` mutation.
4. Wrote `createOneNoteTarget` directly into the GraphQL builder.

### Why the existing safeguards didn't catch it

- The **contract test** validates the variables *shape* (`{data: {noteId, targetCompanyId, …}}`) against the fixture, but the fixture key was `createOneNoteTarget` because *I* put it there. The mutation name was self-consistent with itself, not with Twenty's actual schema.
- The **integration test** would have caught it on first run, but it's gated behind `TWENTY_MCP_INTEGRATION=1` and was never executed against the live VPS.

### The deeper failure

This is **L1 in the retrospective above** ("schemas should be captured from the source of truth, not transcribed by hand"), violated within hours of being written. Copying a pattern from a peer wrapper file (`access.ts`) is still transcription — `access.ts` was *also* hand-authored, so reading it as "source of truth" just propagated the same uncertainty.

### Latent risk in `access.ts`

`access.ts` uses `createOneRole` (line 126) and `updateOneRole` (line 145). If the deployed Twenty drops the `One` prefix universally (as it does for `noteTarget`), then `access_create_role` and `access_update_role` are also broken. They're gated behind `enableMetadata=true`, so they may not have surfaced yet. **Verify against the deployed schema before exercising the access pod.**

### Lesson L8: GraphQL introspection IS the schema. Use it.

Twenty's `/graphql` and `/metadata` endpoints both implement standard GraphQL introspection (`__schema { mutationType { fields { name args { name type { name } } } } }`). That's the source of truth — not the resolver-factory's internal method-key, not a peer wrapper file's hand-authored string. The capture script should:

1. Run a single introspection query against the deployed Twenty.
2. Extract every mutation name + args our wrappers reference.
3. Write them to `inner-tool-schemas.json` (or a sibling fixture) so the contract test can assert "the mutation name our wrapper sends EXISTS in the deployed schema with these arg types."

### Process change to add

Extend [`scripts/capture-inner-schemas.ts`](../scripts/capture-inner-schemas.ts) (or add a sibling `capture-graphql-mutations.ts`) to introspect the GraphQL schema at the same time it captures inner-tool schemas. Add a contract assertion that EVERY GraphQL mutation name in `note-targets.ts` and `access.ts` resolves against the captured introspection. This closes the loop the integration test was supposed to provide but didn't (because gated).

### TL;DR addition

5. **GraphQL mutation names ARE schema. Introspect them, don't infer them.** A `createOneFoo` resolver factory in twenty-server doesn't guarantee a `createOneFoo` mutation in the deployed GraphQL schema. The naming pipeline has multiple layers; the only authoritative answer is the introspection query response.
