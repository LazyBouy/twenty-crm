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
/**
 * HTTP client for Twenty's POST /mcp JSON-RPC endpoint.
 * Mirrors the Bearer-auth pattern used by packages/twenty-zapier/src/utils/requestDb.ts.
 */
class TwentyMcpClient {
    endpoint;
    apiKey;
    fetchImpl;
    constructor({ baseUrl, apiKey, fetchImpl }) {
        this.endpoint = `${baseUrl.replace(/\/+$/, '')}/mcp`;
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
        const response = await this.fetchImpl(this.endpoint, {
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
}
exports.TwentyMcpClient = TwentyMcpClient;
//# sourceMappingURL=twenty-mcp-client.js.map