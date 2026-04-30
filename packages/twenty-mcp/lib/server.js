"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTransport = exports.createServer = void 0;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const crm_1 = require("./tools/crm");
const discovery_1 = require("./tools/discovery");
const twenty_mcp_client_1 = require("./twenty-mcp-client");
const SERVER_INFO = {
    name: 'twenty-mcp',
    version: '0.1.0',
};
const createServer = ({ twentyBaseUrl, twentyApiKey, fetchImpl, }) => {
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
    return server;
};
exports.createServer = createServer;
const createTransport = () => new streamableHttp_js_1.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
exports.createTransport = createTransport;
//# sourceMappingURL=server.js.map