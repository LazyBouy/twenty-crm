import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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

  // Metadata tools (objects/fields/relations + the apply_plan dispatcher) are
  // opt-in via TWENTY_MCP_ENABLE_METADATA. They power the crm-administration
  // sub-agent pod; existing CRM-only deployments stay untouched when the flag
  // is unset.
  if (enableMetadata) {
    const metadata = buildMetadataHandlers(client);

    server.registerTool('metadata_query', metadataToolDefinitions.metadata_query, async (args) =>
      metadata.metadataQuery(args as Parameters<typeof metadata.metadataQuery>[0]),
    );
    server.registerTool(
      'metadata_create_object',
      metadataToolDefinitions.metadata_create_object,
      async (args) =>
        metadata.metadataCreateObject(args as Parameters<typeof metadata.metadataCreateObject>[0]),
    );
    server.registerTool(
      'metadata_create_field',
      metadataToolDefinitions.metadata_create_field,
      async (args) =>
        metadata.metadataCreateField(args as Parameters<typeof metadata.metadataCreateField>[0]),
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
      'metadata_apply_plan',
      metadataToolDefinitions.metadata_apply_plan,
      async (args) =>
        metadata.metadataApplyPlan(args as Parameters<typeof metadata.metadataApplyPlan>[0]),
    );
  }

  return server;
};

export const createTransport = (): StreamableHTTPServerTransport =>
  new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
