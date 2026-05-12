#!/usr/bin/env node
import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
} from 'node:http';

import 'dotenv/config';

import { loadConfig } from './config';
import { createServer, createTransport } from './server';

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const mcpServer = createServer({
    twentyBaseUrl: config.twentyBaseUrl,
    twentyApiKey: config.twentyApiKey,
    enableMetadata: config.enableMetadata,
  });

  // Stateless transport: one Transport per request, per the MCP SDK pattern.
  // Avoids needing session bookkeeping in v1.
  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
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
        const transport = createTransport();
        res.on('close', () => {
          void transport.close();
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'internal', message }));
        } else {
          res.end();
        }
      }
    },
  );

  httpServer.listen(config.mcpPort, config.mcpBind, () => {
    const url = `http://${config.mcpBind}:${config.mcpPort}/mcp`;
    process.stderr.write(
      `[twenty-mcp] listening on ${url} → ${config.twentyBaseUrl}/mcp\n`,
    );
  });
};

main().catch((err) => {
  process.stderr.write(
    `[twenty-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
