# Plan: Unblock `noteTarget` / `timelineActivity` linking via GraphQL bypass

## Context

Phase E workflows that create per-Company evaluation Notes and try to attach them via `noteTarget` are blocked at Twenty with `Object cannot be created by workflow`. Workaround in use: embed `companyId` in the note body, retrieve via title search. CEO experience is degraded — Notes don't appear under the Company's "Notes" tab.

The user's first guess was workspace permissions, but `agentic-grounds-1` is admin. **Permissions aren't the problem** — the gate is purely semantic.

### Root cause (verified by source-reading)

1. The error is thrown by [packages/twenty-server/src/engine/core-modules/record-crud/services/create-record.service.ts:40-50](packages/twenty-server/src/engine/core-modules/record-crud/services/create-record.service.ts#L40-L50):
   ```ts
   if (!canObjectBeManagedByWorkflow({nameSingular, isSystem: flatObjectMetadata.isSystem})) {
     throw new RecordCrudException('Failed to create: Object cannot be created by workflow', ...);
   }
   ```
2. `canObjectBeManagedByWorkflow` ([packages/twenty-shared/src/workflow/utils/canObjectBeManagedByWorkflow.ts](packages/twenty-shared/src/workflow/utils/canObjectBeManagedByWorkflow.ts)) returns `false` for **any object with `isSystem: true`**, regardless of caller. Both `noteTarget` and `timelineActivity` are `isSystem: true`.
3. The actor source is **hardcoded** to `FieldActorSource.WORKFLOW` for every record-crud call, even when the caller is an API-key actor:
   ```ts
   const actorMetadata = params.createdBy ?? { source: FieldActorSource.WORKFLOW, name: 'Workflow' };
   ```
   So even though the auth context carries `type: 'apiKey'`, by the time the gate runs the actor is labelled "WORKFLOW" — which the gate refuses on system objects.

Permissions, role flags, and `agentic-grounds-1`'s admin status are **not consulted by this gate at all**.

### The breakthrough: GraphQL bypasses the gate

The `createOne<Object>` GraphQL resolver ([packages/twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts](packages/twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts)) **does NOT call** `CreateRecordService`. It calls `CommonCreateOneQueryRunnerService.execute` directly. That runner has only two checks: `assertMutationNotOnRemoteObject` and UUID validation — **no workflow/system gate**. So a GraphQL `createOneNoteTarget(data: {…})` from the same `agentic-grounds-1` API key works fine.

This means we can fix this **entirely in the MCP wrapper layer** without forking or patching twenty-server. The pattern already exists in [packages/twenty-mcp/src/tools/access.ts](packages/twenty-mcp/src/tools/access.ts) where GraphQL is used for resolvers Twenty doesn't expose as inner tools.

## Approach

Add a focused tool `link_note_to_record` in a new file `packages/twenty-mcp/src/tools/note-targets.ts` that creates the `NoteTarget` row via the GraphQL `createOneNoteTarget` mutation. This bypasses the workflow gate cleanly, uses an existing pattern, requires no upstream changes, and is reversible.

Optional companion: `link_timeline_activity` for parity (timeline activities are normally auto-generated, but giving agents a manual path closes the family). Defer if scope creep is a concern.

### Tool signature

```ts
link_note_to_record({
  noteId: uuid,                  // required — the Note to link
  targetCompanyId?: uuid,        // exactly one of the three target IDs must be set
  targetPersonId?: uuid,
  targetOpportunityId?: uuid,
})
→ returns the created NoteTarget {id, noteId, targetCompanyId, targetPersonId, targetOpportunityId}
```

### Why this naming

`link_note_to_record` reads as the action the agent actually wants: "attach this Note to this record". `create_note_target` is technically what's happening but exposes Twenty's join-table internals.

### Alternative considered (and rejected)

**Patch twenty-server** to derive actor source from `authContext` and relax the gate for non-WORKFLOW sources. This is the architecturally correct fix — the agent investigation laid out the full patch — but requires forking the upstream image (`twentycrm/twenty:latest`), maintaining the patch, and rebuilding/redeploying on every Twenty version bump. Disproportionate for a 1-line user-visible bug. **Better filed as an upstream PR/issue and tracked separately.**

## Files

### Create
- `packages/twenty-mcp/src/tools/note-targets.ts` — Zod input schema + GraphQL builder + handler + tool definition for `link_note_to_record`. Mirrors the structure of `access.ts` (which uses the same GraphQL transport pattern).
- `packages/twenty-mcp/src/__tests__/note-targets.test.ts` — assertion that the wrapper builds the right `createOneNoteTarget(data: {…})` mutation and validates exactly one target is set.

### Modify
- `packages/twenty-mcp/src/server.ts` — register `link_note_to_record` like the other typed tools.
- `packages/twenty-mcp/src/__tests__/contract.test.ts` — add a contract case for the GraphQL transport: capture the variables and verify shape (no wrapper-only keys, exactly-one-target invariant). Reuses the existing `makeCapturingClient` helper which already tracks `graphqlMutation` calls.
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` — extend the gated integration test with: create note → `link_note_to_record({noteId, targetCompanyId})` → verify the noteTarget appears via `find_one_note({id, includes: [...]})` or a follow-up GraphQL query.
- `packages/twenty-mcp/plans/` — add a new plan + retrospective pair (next section).

### Plans

Per the plan-folder convention we just set up:
- `packages/twenty-mcp/plans/note-target-linking-fix.md` — verbatim copy of this plan
- `packages/twenty-mcp/plans/note-target-linking-fix-retrospective.md` — written after fix lands, capturing the "MCP/tool path != GraphQL path" insight as a reusable lesson

## Implementation sketch (for `note-targets.ts`)

```ts
import { z } from 'zod';
import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';

export const linkNoteToRecordInputSchema = z
  .object({
    noteId: z.string().uuid(),
    targetCompanyId: z.string().uuid().optional(),
    targetPersonId: z.string().uuid().optional(),
    targetOpportunityId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      [v.targetCompanyId, v.targetPersonId, v.targetOpportunityId].filter(Boolean).length === 1,
    { message: 'Exactly one of targetCompanyId / targetPersonId / targetOpportunityId is required' },
  );

const buildCreateNoteTarget = (args: z.infer<typeof linkNoteToRecordInputSchema>) => ({
  query: `mutation($data: NoteTargetCreateInput!) {
    createOneNoteTarget(data: $data) {
      id noteId targetCompanyId targetPersonId targetOpportunityId
    }
  }`,
  variables: {
    data: {
      noteId: args.noteId,
      targetCompanyId: args.targetCompanyId ?? null,
      targetPersonId: args.targetPersonId ?? null,
      targetOpportunityId: args.targetOpportunityId ?? null,
    },
  },
});

export const buildNoteTargetHandlers = (client: TwentyMcpClient) => ({
  linkNoteToRecord: async (
    args: z.infer<typeof linkNoteToRecordInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildCreateNoteTarget(args);
    const data = await client.graphqlMutation(query, variables);

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, result: data }) }],
      isError: false,
    };
  },
});

export const noteTargetToolDefinitions = {
  link_note_to_record: {
    title: 'Link a note to a CRM record (company / person / opportunity)',
    description:
      'Attaches an existing Note to a record so it appears under the record\'s "Notes" tab. ' +
      'Routes through the GraphQL `createOneNoteTarget` mutation, NOT through `execute_tool` — ' +
      "Twenty's record-crud path blocks system-object creation with `Object cannot be created by workflow`. " +
      'Pass `noteId` plus exactly one of `targetCompanyId` / `targetPersonId` / `targetOpportunityId`. ' +
      'For multiple targets, call this tool once per target.',
    inputSchema: linkNoteToRecordInputSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: false },
  },
} as const;
```

## Critical files (read, do not modify)

- [packages/twenty-server/src/engine/core-modules/record-crud/services/create-record.service.ts:40-57](packages/twenty-server/src/engine/core-modules/record-crud/services/create-record.service.ts#L40-L57) — the gate that blocks the MCP path
- [packages/twenty-shared/src/workflow/utils/canObjectBeManagedByWorkflow.ts](packages/twenty-shared/src/workflow/utils/canObjectBeManagedByWorkflow.ts) — the gate function (`isSystem` makes everything fail regardless of actor)
- [packages/twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts](packages/twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts) — the path we're routing through (no gate)
- [packages/twenty-server/src/engine/api/common/common-query-runners/common-create-one-query-runner.service.ts](packages/twenty-server/src/engine/api/common/common-query-runners/common-create-one-query-runner.service.ts) — verified no system/workflow gate
- [packages/twenty-server/src/modules/note/standard-objects/note-target.workspace-entity.ts](packages/twenty-server/src/modules/note/standard-objects/note-target.workspace-entity.ts) — the entity shape (`note`, `targetPerson`, `targetCompany`, `targetOpportunity` plus their `*Id` columns)

## Out of scope (deliberate)

- **Upstream patch to twenty-server.** The proper architectural fix (derive actor source from authContext, relax gate for non-WORKFLOW sources) is correct but requires fork + maintenance + redeploys. File as separate upstream issue/PR. This plan delivers a clean unblock today without that cost.
- **`link_timeline_activity`.** TimelineActivity has the same gate problem and the same GraphQL bypass would work, but timeline activities are normally auto-generated by Twenty's services — agents rarely need to create them. Defer until a concrete need surfaces.
- **Generic `system_object_create` tool.** Tempting, but it would let agents bypass `isSystem` for every system object including ones Twenty intentionally protects. Stay focused on the specific use case.

## Verification

```bash
# (1) Unit tests — fast, no Twenty needed
cd /root/projects/fullstack/twenty-crm/twenty-crm/packages/twenty-mcp
npx tsc --noEmit
npx jest --testTimeout 10000   # all 121 existing + new note-targets + contract assertions must pass

# (2) Live-fire integration — gated, requires running docker-compose stack on port 4440 + 4441
TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 \
TWENTY_BASE_URL=http://localhost:4440 TWENTY_API_KEY=<agentic-grounds-1-jwt> \
  npx jest src/__tests__/integration --testTimeout 30000
# expected: create_note → link_note_to_record({noteId, targetCompanyId}) → success
# expected: the linked note appears in the company's noteTargets relation

# (3) Rebuild + redeploy the dockerized mcp
cd /root/projects/fullstack/twenty-crm/twenty-crm/packages/twenty-docker
docker compose -f docker-compose.deploy.yml build mcp
docker compose -f docker-compose.deploy.yml up -d mcp

# (4) Smoke from the agent side
DISC='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"link_note_to_record","arguments":{"noteId":"<note-uuid>","targetCompanyId":"<company-uuid>"}}}'
curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     --data "$DISC" http://127.0.0.1:4441/mcp | sed -n 's/^data: //p' | head -c 500
# expected: "success": true with a created NoteTarget record
```

Rollback: `git revert <fix-commit>` then `docker compose -f docker-compose.deploy.yml build mcp && up -d mcp`. The CRM server, Caddy gate, and existing tool families are untouched.

## Follow-ups (track but don't block)

1. **Upstream PR/issue** — propose the correct fix to Twenty: derive actor source from authContext in `CreateRecordService`, relax `canObjectBeManagedByWorkflow` to accept non-WORKFLOW sources for system objects. The agent investigation has the patch sketch.
2. **Audit other system objects** — grep `isSystem: true` across Twenty's standard objects. If any other system object is one our agents legitimately need to create (e.g., `attachment`, `comment`, `favorite`?), add the same GraphQL bypass for them.
3. **Discovery hint** — when a user asks for `create_record({object: "noteTarget"})`, the proxy could detect this and surface a friendlier error: "system objects are blocked at the record-crud path; use `link_note_to_record` instead." Small UX win.
