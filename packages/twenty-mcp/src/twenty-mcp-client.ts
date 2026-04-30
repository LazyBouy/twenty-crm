import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type JsonRpcId = string | number;

export type JsonRpcResponse<T = unknown> = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

// Re-export so consumers don't need to import directly from the SDK's deep paths.
export type ToolsCallResult = CallToolResult;

export class TwentyMcpClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'TwentyMcpClientError';
  }
}

type FetchLike = typeof fetch;

export type TwentyMcpClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
};

/**
 * HTTP client for Twenty's POST /mcp JSON-RPC endpoint.
 * Mirrors the Bearer-auth pattern used by packages/twenty-zapier/src/utils/requestDb.ts.
 */
export class TwentyMcpClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor({ baseUrl, apiKey, fetchImpl }: TwentyMcpClientOptions) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/mcp`;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async toolsCall(name: string, args: Record<string, unknown>): Promise<ToolsCallResult> {
    const body = {
      jsonrpc: '2.0' as const,
      id: randomUUID(),
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
      throw new TwentyMcpClientError(
        `Twenty /mcp returned ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`,
        response.status,
      );
    }

    const json = (await response.json()) as JsonRpcResponse<ToolsCallResult>;

    if (json.error) {
      throw new TwentyMcpClientError(json.error.message, json.error.code, json.error.data);
    }

    if (!json.result) {
      throw new TwentyMcpClientError('Twenty /mcp returned no result and no error');
    }

    return json.result;
  }
}
