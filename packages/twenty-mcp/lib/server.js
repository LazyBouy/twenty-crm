"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTransport = exports.createServer = void 0;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const access_1 = require("./tools/access");
const crm_1 = require("./tools/crm");
const discovery_1 = require("./tools/discovery");
const metadata_1 = require("./tools/metadata");
const note_targets_1 = require("./tools/note-targets");
const views_1 = require("./tools/views");
const workflows_1 = require("./tools/workflows");
const twenty_mcp_client_1 = require("./twenty-mcp-client");
const SERVER_INFO = {
    name: 'twenty-mcp',
    version: '0.1.0',
};
const createServer = ({ twentyBaseUrl, twentyApiKey, fetchImpl, enableMetadata = false, }) => {
    const client = new twenty_mcp_client_1.TwentyMcpClient({
        baseUrl: twentyBaseUrl,
        apiKey: twentyApiKey,
        fetchImpl,
    });
    const server = new mcp_js_1.McpServer(SERVER_INFO, {
        capabilities: { tools: {} },
        instructions: 'Twenty CRM (https://twenty.com). Start with the `discovery` tool to see what is available — ' +
            'call discovery({}) for a brief catalog, then discovery({focus: "<tool_name>"}) for the full schema ' +
            'of a specific tool. The five record-CRUD tools (search_records / get_record / create_record / ' +
            'update_record / delete_record) work for any CRM object including custom objects.',
    });
    server.registerTool('discovery', discovery_1.discoveryToolDefinition, async (args) => (0, discovery_1.handleDiscovery)(discovery_1.discoveryInputSchema.parse(args), client));
    const crm = (0, crm_1.buildCrmHandlers)(client);
    server.registerTool('search_records', crm_1.crmToolDefinitions.search_records, async (args) => crm.searchRecords(args));
    server.registerTool('get_record', crm_1.crmToolDefinitions.get_record, async (args) => crm.getRecord(args));
    server.registerTool('create_record', crm_1.crmToolDefinitions.create_record, async (args) => crm.createRecord(args));
    server.registerTool('update_record', crm_1.crmToolDefinitions.update_record, async (args) => crm.updateRecord(args));
    server.registerTool('delete_record', crm_1.crmToolDefinitions.delete_record, async (args) => crm.deleteRecord(args));
    // Note-target linking — bypasses Twenty's record-crud workflow gate via
    // GraphQL `createNoteTarget` because noteTarget is an isSystem object
    // that the standard execute_tool path refuses to create. Always registered
    // (not gated behind enableMetadata) since it's a baseline CRM linkage op.
    const noteTargets = (0, note_targets_1.buildNoteTargetHandlers)(client);
    server.registerTool('link_note_to_record', note_targets_1.noteTargetToolDefinitions.link_note_to_record, async (args) => noteTargets.linkNoteToRecord(args));
    // Metadata + views + access + workflow tools are opt-in via
    // TWENTY_MCP_ENABLE_METADATA. They power the crm-administration sub-agent
    // pod; existing CRM-only deployments stay untouched when the flag is unset.
    if (enableMetadata) {
        const metadata = (0, metadata_1.buildMetadataHandlers)(client, twentyApiKey);
        const views = (0, views_1.buildViewHandlers)(client);
        const access = (0, access_1.buildAccessHandlers)(client);
        const workflows = (0, workflows_1.buildWorkflowHandlers)(client);
        // --- metadata family (data-model + dispatcher + v1.1 extras) ----------
        server.registerTool('metadata_query', metadata_1.metadataToolDefinitions.metadata_query, async (args) => metadata.metadataQuery(args));
        server.registerTool('metadata_create_object', metadata_1.metadataToolDefinitions.metadata_create_object, async (args) => metadata.metadataCreateObject(args));
        server.registerTool('metadata_update_object', metadata_1.metadataToolDefinitions.metadata_update_object, async (args) => metadata.metadataUpdateObject(args));
        server.registerTool('metadata_create_field', metadata_1.metadataToolDefinitions.metadata_create_field, async (args) => metadata.metadataCreateField(args));
        server.registerTool('metadata_update_field', metadata_1.metadataToolDefinitions.metadata_update_field, async (args) => metadata.metadataUpdateField(args));
        server.registerTool('metadata_create_many_fields', metadata_1.metadataToolDefinitions.metadata_create_many_fields, async (args) => metadata.metadataCreateManyFields(args));
        server.registerTool('metadata_create_relation', metadata_1.metadataToolDefinitions.metadata_create_relation, async (args) => metadata.metadataCreateRelation(args));
        server.registerTool('metadata_get_calling_actor', metadata_1.metadataToolDefinitions.metadata_get_calling_actor, async (args) => metadata.metadataGetCallingActor(args));
        server.registerTool('metadata_apply_plan', metadata_1.metadataToolDefinitions.metadata_apply_plan, async (args) => metadata.metadataApplyPlan(args));
        // --- views family ------------------------------------------------------
        server.registerTool('metadata_create_view', views_1.viewToolDefinitions.metadata_create_view, async (args) => views.metadataCreateView(args));
        server.registerTool('metadata_update_view', views_1.viewToolDefinitions.metadata_update_view, async (args) => views.metadataUpdateView(args));
        server.registerTool('metadata_create_view_field', views_1.viewToolDefinitions.metadata_create_view_field, async (args) => views.metadataCreateViewField(args));
        server.registerTool('metadata_update_view_field', views_1.viewToolDefinitions.metadata_update_view_field, async (args) => views.metadataUpdateViewField(args));
        server.registerTool('metadata_create_many_view_fields', views_1.viewToolDefinitions.metadata_create_many_view_fields, async (args) => views.metadataCreateManyViewFields(args));
        server.registerTool('metadata_create_view_filter', views_1.viewToolDefinitions.metadata_create_view_filter, async (args) => views.metadataCreateViewFilter(args));
        server.registerTool('metadata_update_view_filter', views_1.viewToolDefinitions.metadata_update_view_filter, async (args) => views.metadataUpdateViewFilter(args));
        server.registerTool('metadata_create_view_sort', views_1.viewToolDefinitions.metadata_create_view_sort, async (args) => views.metadataCreateViewSort(args));
        // --- access family (GraphQL passthrough) ------------------------------
        server.registerTool('access_create_role', access_1.accessToolDefinitions.access_create_role, async (args) => access.accessCreateRole(args));
        server.registerTool('access_update_role', access_1.accessToolDefinitions.access_update_role, async (args) => access.accessUpdateRole(args));
        server.registerTool('access_upsert_object_permissions', access_1.accessToolDefinitions.access_upsert_object_permissions, async (args) => access.accessUpsertObjectPermissions(args));
        server.registerTool('access_upsert_field_permissions', access_1.accessToolDefinitions.access_upsert_field_permissions, async (args) => access.accessUpsertFieldPermissions(args));
        server.registerTool('access_send_invitations', access_1.accessToolDefinitions.access_send_invitations, async (args) => access.accessSendInvitations(args));
        server.registerTool('access_create_api_key', access_1.accessToolDefinitions.access_create_api_key, async (args) => access.accessCreateApiKey(args));
        server.registerTool('access_revoke_api_key', access_1.accessToolDefinitions.access_revoke_api_key, async (args) => access.accessRevokeApiKey(args));
        // --- workflow family (specialised inner tools, NOT in apply_plan) -----
        server.registerTool('workflow_create_complete', workflows_1.workflowToolDefinitions.workflow_create_complete, async (args) => workflows.workflowCreateComplete(args));
        server.registerTool('workflow_activate_version', workflows_1.workflowToolDefinitions.workflow_activate_version, async (args) => workflows.workflowActivateVersion(args));
        server.registerTool('workflow_deactivate_version', workflows_1.workflowToolDefinitions.workflow_deactivate_version, async (args) => workflows.workflowDeactivateVersion(args));
        server.registerTool('workflow_create_version_step', workflows_1.workflowToolDefinitions.workflow_create_version_step, async (args) => workflows.workflowCreateVersionStep(args));
        server.registerTool('workflow_update_version_step', workflows_1.workflowToolDefinitions.workflow_update_version_step, async (args) => workflows.workflowUpdateVersionStep(args));
        server.registerTool('workflow_create_version_edge', workflows_1.workflowToolDefinitions.workflow_create_version_edge, async (args) => workflows.workflowCreateVersionEdge(args));
        server.registerTool('workflow_create_draft_from_version', workflows_1.workflowToolDefinitions.workflow_create_draft_from_version, async (args) => workflows.workflowCreateDraftFromVersion(args));
    }
    return server;
};
exports.createServer = createServer;
const createTransport = () => new streamableHttp_js_1.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
exports.createTransport = createTransport;
//# sourceMappingURL=server.js.map