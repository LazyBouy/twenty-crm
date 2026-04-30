#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
require("dotenv/config");
const config_1 = require("./config");
const server_1 = require("./server");
const readJsonBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    if (chunks.length === 0)
        return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
};
const main = async () => {
    const config = (0, config_1.loadConfig)();
    const mcpServer = (0, server_1.createServer)({
        twentyBaseUrl: config.twentyBaseUrl,
        twentyApiKey: config.twentyApiKey,
    });
    // Stateless transport: one Transport per request, per the MCP SDK pattern.
    // Avoids needing session bookkeeping in v1.
    const httpServer = (0, node_http_1.createServer)(async (req, res) => {
        if (!req.url?.startsWith('/mcp')) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'not_found', hint: 'POST /mcp' }));
            return;
        }
        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Allow', 'POST');
            res.end();
            return;
        }
        try {
            const body = await readJsonBody(req);
            const transport = (0, server_1.createTransport)();
            res.on('close', () => {
                void transport.close();
            });
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, body);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal', message }));
            }
            else {
                res.end();
            }
        }
    });
    httpServer.listen(config.mcpPort, config.mcpBind, () => {
        const url = `http://${config.mcpBind}:${config.mcpPort}/mcp`;
        process.stderr.write(`[twenty-mcp] listening on ${url} → ${config.twentyBaseUrl}/mcp\n`);
    });
};
main().catch((err) => {
    process.stderr.write(`[twenty-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map