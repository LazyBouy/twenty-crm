# Plan: Fix CRM wrapper bugs + audit + contract testing for `packages/twenty-mcp`

## Context

A wrapper bug in [packages/twenty-mcp/src/tools/crm.ts](packages/twenty-mcp/src/tools/crm.ts) cost ~1.1M tokens during a real workflow trying to write data through the MCP. The wrapper accepts `{object, data: {...}}` and forwards `{data: {...}}` to Twenty's inner `create_<singular>` / `update_<singular>` tools — but those inner tools are `additionalProperties: false` with field keys at the top level, so they reject the call (`Object company doesn't have any "data" field`). Same shape error applies to `update_record` (id + spread data) and `search_records` (top-level field filters, not a `filter:` wrapper).

The unit tests (`crm.test.ts`) never caught this because they assert "wrapper forwards X" with mocks — they don't verify X is actually shaped the way Twenty expects. That's the structural defect: **the test layer has no contract verification against the real inner-tool schemas**.

A full audit of all 5 wrapper files against Twenty's source-of-truth schemas (51 inner tools / 7 GraphQL mutations checked) shows the bug is contained to `crm.ts` — `metadata.ts`, `views.ts`, `workflows.ts`, and `access.ts` all forward correctly. So the fix is bounded, but the prevention work has to extend to the test layer so future tool additions don't repeat this.

## Audit findings (51 inner tools + 7 GraphQL mutations verified)

| File | Tool | Inner shape (source) | Wrapper sends | Verdict |
|---|---|---|---|---|
| **crm.ts** | `find_<plural>` | `{limit, offset, orderBy, …top-level field filters, or, and, not}` per [find-tool.zod-schema.ts:17-48](packages/twenty-server/src/engine/core-modules/record-crud/zod-schemas/find-tool.zod-schema.ts#L17-L48) | `{query?, filter?, limit?, fields?}` | **MISMATCH** (`filter` should spread; `query`/`fields` don't exist on Twenty) |
| **crm.ts** | `find_one_<singular>` | `{id}` | `{id, fields?}` | **MATCH** (`fields` ignored) |
| **crm.ts** | `create_<singular>` | top-level field keys per [generate-create-record-input-schema.util.ts](packages/twenty-server/src/engine/core-modules/record-crud/utils/generate-create-record-input-schema.util.ts) | `{data: {...}}` | **MISMATCH** (data wrapper rejected) |
| **crm.ts** | `update_<singular>` | `{id, ...fields}` per [generate-update-record-input-schema.util.ts](packages/twenty-server/src/engine/core-modules/record-crud/utils/generate-update-record-input-schema.util.ts) | `{id, data: {...}}` | **MISMATCH** (data wrapper rejected) |
| **crm.ts** | `delete_<singular>` | `{id}` | `{id}` | **MATCH** |
| **metadata.ts** | all 12 inner tools | flat per `*-tools.factory.ts` | flat (with `argsTransform` for `create_many_relation_fields`) | **MATCH** |
| **views.ts** | all 8 inner tools | flat per `view{,-field,-filter,-sort}-tools.factory.ts` | flat | **MATCH** |
| **workflows.ts** | all 7 inner tools | flat per `workflow/.../tool.ts` files | flat | **MATCH** |
| **access.ts** | 7 GraphQL mutations | `{input: {...}}` (or top-level for `sendInvitations`) | matches resolver signatures | **MATCH** |

**Net:** 3 confirmed bugs, all in `crm.ts`. The other 4 wrapper files are clean.

## Fix

### A. `packages/twenty-mcp/src/tools/crm.ts` — three changes

**A.1. Realign `searchInputSchema` with Twenty's actual `find_<plural>` schema.**
Drop imaginary args (`query`, `fields`) and add the real ones (`orderBy`, `offset`, `or`, `and`, `not`). Reframe `filter` description as "top-level field filters that spread" so the agent's mental model matches what we forward. Reuse the operator vocabulary already documented in [views.ts](packages/twenty-mcp/src/tools/views.ts) where overlapping (e.g., for filter operators).

```ts
export const searchInputSchema = z.object({
  object: objectArg,
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Top-level field filters, spread into the call. Each key is a field name; the value is an operator object. ' +
      'Examples: {city: {eq: "Berlin"}}, {employees: {gt: 100}}, {name: {like: "%acme%"}}. ' +
      'Combine with `or`/`and`/`not` for boolean composition.',
    ),
  or: z.array(z.record(z.string(), z.unknown())).optional()
    .describe('OR composition — match if ANY filter in the array matches.'),
  and: z.array(z.record(z.string(), z.unknown())).optional()
    .describe('AND composition — match if ALL filters in the array match.'),
  not: z.record(z.string(), z.unknown()).optional()
    .describe('NOT — match if the filter does NOT match.'),
  orderBy: z.array(z.record(z.string(), z.string())).optional()
    .describe('Sort: array of single-key objects, e.g. [{employees: "DescNullsLast"}, {name: "AscNullsFirst"}]. Required for "top N" / "largest" / "smallest" queries.'),
  limit: z.number().int().positive().max(100).optional()
    .describe('Max records to return (Twenty default 10, max 100).'),
  offset: z.number().int().nonnegative().optional().describe('Records to skip.'),
});
```

**A.2. Fix the three handlers** (matches what the user proposed plus the search rewrite):

```ts
searchRecords: (args: z.infer<typeof searchInputSchema>) => {
  const { object, filter, ...rest } = args;
  return wrapInExecute(client, innerToolName('search', object), {
    ...rest,
    ...(filter ?? {}),
  });
},
getRecord: (args) =>                                                     // unchanged
  wrapInExecute(client, innerToolName('get', args.object), { id: args.id }),
createRecord: (args: z.infer<typeof createInputSchema>) =>
  wrapInExecute(client, innerToolName('create', args.object), args.data),
updateRecord: (args: z.infer<typeof updateInputSchema>) =>
  wrapInExecute(client, innerToolName('update', args.object), { id: args.id, ...args.data }),
deleteRecord: (args) =>                                                  // unchanged
  wrapInExecute(client, innerToolName('delete', args.object), { id: args.id }),
```

Drop the now-unused `stripObject` helper and the `fields?` arg on `getInputSchema` (Twenty's `find_one` doesn't accept it; agents who passed it were getting it silently dropped).

**A.3. Update tool descriptions in `crmToolDefinitions`** to remove the misleading `filter`-as-wrapper language and reflect the new shape. Specifically: `search_records.description` should say "field filters spread at the top level" and reference `discovery({focus: "find_<plural>"})` for the live schema.

### B. `packages/twenty-mcp/src/__tests__/crm.test.ts` — replace assertion shape

Today's tests assert `expect(toolsCall).toHaveBeenCalledWith('execute_tool', { toolName: 'create_person', arguments: { data: {…} } })`. That assertion *passed* with a buggy implementation — the test suite needs to assert against shapes Twenty would actually accept, not against whatever the wrapper happens to produce.

Replace each existing CRM test with the post-patch expected shape (e.g., `arguments: { name: 'Acme' }` with no `data` wrapper). This catches future regressions of the same class.

### C. New contract-test infrastructure (the structural fix)

This is the change that prevents the next bug of this shape from shipping. Three pieces:

**C.1. Schema-snapshot fixtures.** Add `packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json` — a fixture file containing the JSON Schemas Twenty publishes via `learn_tools` for the inner tools each wrapper invokes. Generated once from a live Twenty (the docker-compose deploy) via a small helper script:

```
packages/twenty-mcp/scripts/capture-inner-schemas.ts
```

The script connects to `${TWENTY_BASE_URL}/mcp` with the workspace API key, calls `learn_tools` for the 30+ inner tool names the wrappers use, and writes the result to the fixture. Re-run when Twenty's schemas change (which would be a server-version bump, captured in CI).

**C.2. Contract tests using ajv.** Add `packages/twenty-mcp/src/__tests__/contract.test.ts` that:
- Loads the fixture.
- For each wrapper handler (search/get/create/update/delete + every metadata/views/workflows tool), constructs a representative input, runs the handler with a mock client that captures the forwarded JSON-RPC `arguments`, and validates the captured payload against the corresponding inner schema using ajv.
- Fails loudly if a wrapper produces a payload that wouldn't be accepted by Twenty.

This is the test layer that would have caught the bug the moment it was introduced.

**C.3. Live-fire integration test (opt-in, gated).** Add `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` that runs only when `TWENTY_MCP_INTEGRATION=1` is set. It:
- Boots against a running Twenty (the docker-compose `mcp` + `server` stack on `:4441` / `:4440`).
- Round-trips a full lifecycle on `people`: create → search (with filter) → get → update → delete.
- Asserts each call returns `success: true` from Twenty's response envelope.

This is the safety net for "the schema fixture matches reality" — a 5–10s test gated behind an env var so unit-test runs stay fast.

### D. Update `discovery.ts` description to reduce ambiguity

Tighten the `discovery` tool description: explicitly tell agents to call `discovery({focus: "<inner_tool_name>"})` BEFORE invoking the convenience CRUD tools if their input doesn't fit the documented shape — the inner tool's schema is the authority.

## Critical files (modify)

- [packages/twenty-mcp/src/tools/crm.ts](packages/twenty-mcp/src/tools/crm.ts) — sections A.1 / A.2 / A.3
- [packages/twenty-mcp/src/__tests__/crm.test.ts](packages/twenty-mcp/src/__tests__/crm.test.ts) — section B
- [packages/twenty-mcp/src/tools/discovery.ts](packages/twenty-mcp/src/tools/discovery.ts) — section D (description tweak only)

## Critical files (create)

- `packages/twenty-mcp/scripts/capture-inner-schemas.ts` — section C.1 helper
- `packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json` — captured fixture
- `packages/twenty-mcp/src/__tests__/contract.test.ts` — section C.2
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` — section C.3

## Critical files (read, do not modify)

- [packages/twenty-server/src/engine/core-modules/record-crud/zod-schemas/find-tool.zod-schema.ts](packages/twenty-server/src/engine/core-modules/record-crud/zod-schemas/find-tool.zod-schema.ts) — source of truth for `find_<plural>` shape (verified: `{limit, offset, orderBy, …field filters, or, and, not}`)
- `packages/twenty-server/src/engine/core-modules/record-crud/utils/generate-create-record-input-schema.util.ts` — source of truth for `create_<singular>`
- `packages/twenty-server/src/engine/core-modules/record-crud/utils/generate-update-record-input-schema.util.ts` — source of truth for `update_<singular>`
- [packages/twenty-server/src/engine/core-modules/tool-provider/tools/execute-tool.tool.ts](packages/twenty-server/src/engine/core-modules/tool-provider/tools/execute-tool.tool.ts) — confirms `additionalProperties: false` on inner schemas (line 29)

## Out of scope (not touching)

- The 4 clean wrapper files (`metadata.ts`, `views.ts`, `workflows.ts`, `access.ts`). Audit confirms they're correct; introducing changes there would risk regressions for no benefit.
- The `enableMetadata` flag and `metadata_*` tool family added by the user — left as-is.
- Redesigning the convenience tools to a flat-arg model (`{object, ...fields}` instead of `{object, data: {...}}`). The current wrapper-then-flatten approach keeps types Zod-checkable; flattening would force `additionalProperties: true` on the wrapper and weaken validation. Defer.

## Verification

```bash
# (1) lint + typecheck + unit tests — fast, no Twenty needed
cd /root/projects/fullstack/twenty-crm/twenty-crm/packages/twenty-mcp
npx tsc --noEmit
npx jest --testTimeout 10000        # contract tests must run by default

# (2) capture schema fixture from live Twenty (one-off / on Twenty version bumps)
TWENTY_BASE_URL=http://localhost:4440 TWENTY_API_KEY=<key> \
  npx tsx scripts/capture-inner-schemas.ts

# (3) live-fire integration test — gated, requires running docker-compose stack
TWENTY_MCP_INTEGRATION=1 \
TWENTY_BASE_URL=http://localhost:4440 TWENTY_API_KEY=<key> \
  npx jest src/__tests__/integration --testTimeout 30000
# expected output: people CRUD round-trip succeeds end-to-end

# (4) rebuild & redeploy the dockerized mcp service (the rollout step the user gave)
cd /root/projects/fullstack/twenty-crm/twenty-crm/packages/twenty-docker
docker compose -f docker-compose.deploy.yml build mcp
docker compose -f docker-compose.deploy.yml up -d mcp

# (5) sanity-call the deployed proxy
DISC='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_record","arguments":{"object":"company","data":{"name":"AuditFix QA"}}}}'
curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     --data "$DISC" http://127.0.0.1:4441/mcp | sed -n 's/^data: //p' | head -c 500
# expected: "success":true with a created company record
```

Rollback: `git revert <fix-commit>` then `docker compose -f docker-compose.deploy.yml build mcp && up -d mcp`. The CRM server, Caddy gate, and other tool families are untouched.
