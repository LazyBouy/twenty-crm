"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwentyMcpClient = exports.TwentyMcpClientError = void 0;
const node_crypto_1 = require("node:crypto");
class TwentyMcpClientError extends Error {
    code;
    data;
    constructor(message, code, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = 'TwentyMcpClientError';
    }
}
exports.TwentyMcpClientError = TwentyMcpClientError;
class TwentyMcpClient {
    mcpEndpoint;
    graphqlEndpoint;
    apiKey;
    fetchImpl;
    constructor({ baseUrl, apiKey, fetchImpl }) {
        const trimmed = baseUrl.replace(/\/+$/, '');
        this.mcpEndpoint = `${trimmed}/mcp`;
        this.graphqlEndpoint = `${trimmed}/metadata`;
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl ?? fetch;
    }
    async toolsCall(name, args) {
        const body = {
            jsonrpc: '2.0',
            id: (0, node_crypto_1.randomUUID)(),
            method: 'tools/call',
            params: { name, arguments: args },
        };
        const response = await this.fetchImpl(this.mcpEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new TwentyMcpClientError(`Twenty /mcp returned ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`, response.status);
        }
        const json = (await response.json());
        if (json.error) {
            throw new TwentyMcpClientError(json.error.message, json.error.code, json.error.data);
        }
        if (!json.result) {
            throw new TwentyMcpClientError('Twenty /mcp returned no result and no error');
        }
        return json.result;
    }
    /**
     * Issue a GraphQL query or mutation against Twenty's /metadata endpoint.
     * Used by access tools (roles, permissions, API keys) since Twenty does not
     * expose inner MCP tools for these. Errors come back in the GraphQL
     * `{errors: [...]}` envelope; we normalise to TwentyMcpClientError so callers
     * don't branch on transport.
     */
    async graphqlMutation(query, variables = {}) {
        const response = await this.fetchImpl(this.graphqlEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ query, variables }),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new TwentyMcpClientError(`Twenty /metadata returned ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`, response.status);
        }
        const json = (await response.json());
        if (json.errors && json.errors.length > 0) {
            const first = json.errors[0];
            const code = first.extensions?.code ?? first.extensions?.subCode;
            const message = first.extensions?.userFriendlyMessage ?? first.message;
            throw new TwentyMcpClientError(message, undefined, { code, errors: json.errors });
        }
        if (json.data === undefined) {
            throw new TwentyMcpClientError('Twenty /metadata returned no data and no errors');
        }
        return json.data;
    }
}
exports.TwentyMcpClient = TwentyMcpClient;
//# sourceMappingURL=twenty-mcp-client.js.map