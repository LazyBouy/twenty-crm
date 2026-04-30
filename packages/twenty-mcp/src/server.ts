import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  buildCrmHandlers,
  crmToolDefinitions,
  resolveInnerToolNames,
} from './tools/crm';
import {
  discoveryInputSchema,
  discoveryToolDefinition,
  handleDiscovery,
} from './tools/discovery';
import { TwentyMcpClient } from './twenty-mcp-client';

const SERVER_INFO = {
  name: 'twenty-mcp',
  version: '0.1.0',
} as const;

export type CreateServerOptions = {
  twentyBaseUrl: string;
  twentyApiKey: string;
  innerTools?: ReturnType<typeof resolveInnerToolNames>;
  fetchImpl?: typeof fetch;
};

export const createServer = ({
  twentyBaseUrl,
  twentyApiKey,
  innerTools = resolveInnerToolNames(),
  fetchImpl,
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

  const crm = buildCrmHandlers(client, innerTools);

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

  return server;
};

export const createTransport = (): StreamableHTTPServerTransport =>
  new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
