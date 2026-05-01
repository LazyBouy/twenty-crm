import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { accessToolDefinitions, buildAccessHandlers } from './tools/access';
import { buildCrmHandlers, crmToolDefinitions } from './tools/crm';
import {
  discoveryInputSchema,
  discoveryToolDefinition,
  handleDiscovery,
} from './tools/discovery';
import {
  buildMetadataHandlers,
  metadataToolDefinitions,
} from './tools/metadata';
import {
  buildNoteTargetHandlers,
  noteTargetToolDefinitions,
} from './tools/note-targets';
import { buildViewHandlers, viewToolDefinitions } from './tools/views';
import { buildWorkflowHandlers, workflowToolDefinitions } from './tools/workflows';
import { TwentyMcpClient } from './twenty-mcp-client';

const SERVER_INFO = {
  name: 'twenty-mcp',
  version: '0.1.0',
} as const;

export type CreateServerOptions = {
  twentyBaseUrl: string;
  twentyApiKey: string;
  fetchImpl?: typeof fetch;
  enableMetadata?: boolean;
};

export const createServer = ({
  twentyBaseUrl,
  twentyApiKey,
  fetchImpl,
  enableMetadata = false,
}: CreateServerOptions): McpServer => {
  const client = new TwentyMcpClient({
    baseUrl: twentyBaseUrl,
    apiKey: twentyApiKey,
    fetchImpl,
  });

  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      'Twenty CRM (https://twenty.com). Start with the `discovery` tool to see what is available — ' +
      'call discovery({}) for a brief catalog, then discovery({focus: "<tool_name>"}) for the full schema ' +
      'of a specific tool. The five record-CRUD tools (search_records / get_record / create_record / ' +
      'update_record / delete_record) work for any CRM object including custom objects.',
  });

  server.registerTool(
    'discovery',
    discoveryToolDefinition,
    async (args) => handleDiscovery(discoveryInputSchema.parse(args), client),
  );

  const crm = buildCrmHandlers(client);

  server.registerTool('search_records', crmToolDefinitions.search_records, async (args) =>
    crm.searchRecords(args as Parameters<typeof crm.searchRecords>[0]),
  );
  server.registerTool('get_record', crmToolDefinitions.get_record, async (args) =>
    crm.getRecord(args as Parameters<typeof crm.getRecord>[0]),
  );
  server.registerTool('create_record', crmToolDefinitions.create_record, async (args) =>
    crm.createRecord(args as Parameters<typeof crm.createRecord>[0]),
  );
  server.registerTool('update_record', crmToolDefinitions.update_record, async (args) =>
    crm.updateRecord(args as Parameters<typeof crm.updateRecord>[0]),
  );
  server.registerTool('delete_record', crmToolDefinitions.delete_record, async (args) =>
    crm.deleteRecord(args as Parameters<typeof crm.deleteRecord>[0]),
  );

  // Note-target linking — bypasses Twenty's record-crud workflow gate via
  // GraphQL `createOneNoteTarget` because noteTarget is an isSystem object
  // that the standard execute_tool path refuses to create. Always registered
  // (not gated behind enableMetadata) since it's a baseline CRM linkage op.
  const noteTargets = buildNoteTargetHandlers(client);
  server.registerTool(
    'link_note_to_record',
    noteTargetToolDefinitions.link_note_to_record,
    async (args) =>
      noteTargets.linkNoteToRecord(args as Parameters<typeof noteTargets.linkNoteToRecord>[0]),
  );

  // Metadata + views + access + workflow tools are opt-in via
  // TWENTY_MCP_ENABLE_METADATA. They power the crm-administration sub-agent
  // pod; existing CRM-only deployments stay untouched when the flag is unset.
  if (enableMetadata) {
    const metadata = buildMetadataHandlers(client, twentyApiKey);
    const views = buildViewHandlers(client);
    const access = buildAccessHandlers(client);
    const workflows = buildWorkflowHandlers(client);

    // --- metadata family (data-model + dispatcher + v1.1 extras) ----------
    server.registerTool('metadata_query', metadataToolDefinitions.metadata_query, async (args) =>
      metadata.metadataQuery(args as Parameters<typeof metadata.metadataQuery>[0]),
    );
    server.registerTool(
      'metadata_create_object',
      metadataToolDefinitions.metadata_create_object,
      async (args) =>
        metadata.metadataCreateObject(
          args as Parameters<typeof metadata.metadataCreateObject>[0],
        ),
    );
    server.registerTool(
      'metadata_update_object',
      metadataToolDefinitions.metadata_update_object,
      async (args) =>
        metadata.metadataUpdateObject(
          args as Parameters<typeof metadata.metadataUpdateObject>[0],
        ),
    );
    server.registerTool(
      'metadata_create_field',
      metadataToolDefinitions.metadata_create_field,
      async (args) =>
        metadata.metadataCreateField(args as Parameters<typeof metadata.metadataCreateField>[0]),
    );
    server.registerTool(
      'metadata_update_field',
      metadataToolDefinitions.metadata_update_field,
      async (args) =>
        metadata.metadataUpdateField(args as Parameters<typeof metadata.metadataUpdateField>[0]),
    );
    server.registerTool(
      'metadata_create_many_fields',
      metadataToolDefinitions.metadata_create_many_fields,
      async (args) =>
        metadata.metadataCreateManyFields(
          args as Parameters<typeof metadata.metadataCreateManyFields>[0],
        ),
    );
    server.registerTool(
      'metadata_create_relation',
      metadataToolDefinitions.metadata_create_relation,
      async (args) =>
        metadata.metadataCreateRelation(
          args as Parameters<typeof metadata.metadataCreateRelation>[0],
        ),
    );
    server.registerTool(
      'metadata_get_calling_actor',
      metadataToolDefinitions.metadata_get_calling_actor,
      async (args) =>
        metadata.metadataGetCallingActor(
          args as Parameters<typeof metadata.metadataGetCallingActor>[0],
        ),
    );
    server.registerTool(
      'metadata_apply_plan',
      metadataToolDefinitions.metadata_apply_plan,
      async (args) =>
        metadata.metadataApplyPlan(args as Parameters<typeof metadata.metadataApplyPlan>[0]),
    );

    // --- views family ------------------------------------------------------
    server.registerTool(
      'metadata_create_view',
      viewToolDefinitions.metadata_create_view,
      async (args) =>
        views.metadataCreateView(args as Parameters<typeof views.metadataCreateView>[0]),
    );
    server.registerTool(
      'metadata_update_view',
      viewToolDefinitions.metadata_update_view,
      async (args) =>
        views.metadataUpdateView(args as Parameters<typeof views.metadataUpdateView>[0]),
    );
    server.registerTool(
      'metadata_create_view_field',
      viewToolDefinitions.metadata_create_view_field,
      async (args) =>
        views.metadataCreateViewField(
          args as Parameters<typeof views.metadataCreateViewField>[0],
        ),
    );
    server.registerTool(
      'metadata_update_view_field',
      viewToolDefinitions.metadata_update_view_field,
      async (args) =>
        views.metadataUpdateViewField(
          args as Parameters<typeof views.metadataUpdateViewField>[0],
        ),
    );
    server.registerTool(
      'metadata_create_many_view_fields',
      viewToolDefinitions.metadata_create_many_view_fields,
      async (args) =>
        views.metadataCreateManyViewFields(
          args as Parameters<typeof views.metadataCreateManyViewFields>[0],
        ),
    );
    server.registerTool(
      'metadata_create_view_filter',
      viewToolDefinitions.metadata_create_view_filter,
      async (args) =>
        views.metadataCreateViewFilter(
          args as Parameters<typeof views.metadataCreateViewFilter>[0],
        ),
    );
    server.registerTool(
      'metadata_update_view_filter',
      viewToolDefinitions.metadata_update_view_filter,
      async (args) =>
        views.metadataUpdateViewFilter(
          args as Parameters<typeof views.metadataUpdateViewFilter>[0],
        ),
    );
    server.registerTool(
      'metadata_create_view_sort',
      viewToolDefinitions.metadata_create_view_sort,
      async (args) =>
        views.metadataCreateViewSort(
          args as Parameters<typeof views.metadataCreateViewSort>[0],
        ),
    );

    // --- access family (GraphQL passthrough) ------------------------------
    server.registerTool(
      'access_create_role',
      accessToolDefinitions.access_create_role,
      async (args) =>
        access.accessCreateRole(args as Parameters<typeof access.accessCreateRole>[0]),
    );
    server.registerTool(
      'access_update_role',
      accessToolDefinitions.access_update_role,
      async (args) =>
        access.accessUpdateRole(args as Parameters<typeof access.accessUpdateRole>[0]),
    );
    server.registerTool(
      'access_upsert_object_permissions',
      accessToolDefinitions.access_upsert_object_permissions,
      async (args) =>
        access.accessUpsertObjectPermissions(
          args as Parameters<typeof access.accessUpsertObjectPermissions>[0],
        ),
    );
    server.registerTool(
      'access_upsert_field_permissions',
      accessToolDefinitions.access_upsert_field_permissions,
      async (args) =>
        access.accessUpsertFieldPermissions(
          args as Parameters<typeof access.accessUpsertFieldPermissions>[0],
        ),
    );
    server.registerTool(
      'access_send_invitations',
      accessToolDefinitions.access_send_invitations,
      async (args) =>
        access.accessSendInvitations(
          args as Parameters<typeof access.accessSendInvitations>[0],
        ),
    );
    server.registerTool(
      'access_create_api_key',
      accessToolDefinitions.access_create_api_key,
      async (args) =>
        access.accessCreateApiKey(args as Parameters<typeof access.accessCreateApiKey>[0]),
    );
    server.registerTool(
      'access_revoke_api_key',
      accessToolDefinitions.access_revoke_api_key,
      async (args) =>
        access.accessRevokeApiKey(args as Parameters<typeof access.accessRevokeApiKey>[0]),
    );

    // --- workflow family (specialised inner tools, NOT in apply_plan) -----
    server.registerTool(
      'workflow_create_complete',
      workflowToolDefinitions.workflow_create_complete,
      async (args) =>
        workflows.workflowCreateComplete(
          args as Parameters<typeof workflows.workflowCreateComplete>[0],
        ),
    );
    server.registerTool(
      'workflow_activate_version',
      workflowToolDefinitions.workflow_activate_version,
      async (args) =>
        workflows.workflowActivateVersion(
          args as Parameters<typeof workflows.workflowActivateVersion>[0],
        ),
    );
    server.registerTool(
      'workflow_deactivate_version',
      workflowToolDefinitions.workflow_deactivate_version,
      async (args) =>
        workflows.workflowDeactivateVersion(
          args as Parameters<typeof workflows.workflowDeactivateVersion>[0],
        ),
    );
    server.registerTool(
      'workflow_create_version_step',
      workflowToolDefinitions.workflow_create_version_step,
      async (args) =>
        workflows.workflowCreateVersionStep(
          args as Parameters<typeof workflows.workflowCreateVersionStep>[0],
        ),
    );
    server.registerTool(
      'workflow_update_version_step',
      workflowToolDefinitions.workflow_update_version_step,
      async (args) =>
        workflows.workflowUpdateVersionStep(
          args as Parameters<typeof workflows.workflowUpdateVersionStep>[0],
        ),
    );
    server.registerTool(
      'workflow_create_version_edge',
      workflowToolDefinitions.workflow_create_version_edge,
      async (args) =>
        workflows.workflowCreateVersionEdge(
          args as Parameters<typeof workflows.workflowCreateVersionEdge>[0],
        ),
    );
    server.registerTool(
      'workflow_create_draft_from_version',
      workflowToolDefinitions.workflow_create_draft_from_version,
      async (args) =>
        workflows.workflowCreateDraftFromVersion(
          args as Parameters<typeof workflows.workflowCreateDraftFromVersion>[0],
        ),
    );
  }

  return server;
};

export const createTransport = (): StreamableHTTPServerTransport =>
  new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
