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
 * HTTP client for Twenty's POST /mcp JSON-RPC endpoint AND POST /metadata GraphQL.
 * The /mcp endpoint is the primary path (used by the discovery + CRM + most metadata
 * tools). The /metadata GraphQL endpoint is used only for access ops (roles,
 * permissions, members, API keys, webhooks) which Twenty exposes as GraphQL
 * resolvers without inner-tool wrappers — see access.ts.
 *
 * Both endpoints share the same workspace API key bearer auth.
 * Mirrors the Bearer-auth pattern used by packages/twenty-zapier/src/utils/requestDb.ts.
 */

export type GraphqlError = {
  message: string;
  extensions?: { code?: string; subCode?: string; userFriendlyMessage?: string };
  path?: ReadonlyArray<string | number>;
};

export class TwentyMcpClient {
  private readonly mcpEndpoint: string;
  private readonly graphqlEndpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor({ baseUrl, apiKey, fetchImpl }: TwentyMcpClientOptions) {
    const trimmed = baseUrl.replace(/\/+$/, '');
    this.mcpEndpoint = `${trimmed}/mcp`;
    this.graphqlEndpoint = `${trimmed}/metadata`;
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

  /**
   * Issue a GraphQL query or mutation against Twenty's /metadata endpoint.
   * Used by access tools (roles, permissions, API keys) since Twenty does not
   * expose inner MCP tools for these. Errors come back in the GraphQL
   * `{errors: [...]}` envelope; we normalise to TwentyMcpClientError so callers
   * don't branch on transport.
   */
  async graphqlMutation<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
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
      throw new TwentyMcpClientError(
        `Twenty /metadata returned ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`,
        response.status,
      );
    }

    const json = (await response.json()) as { data?: T; errors?: GraphqlError[] };

    if (json.errors && json.errors.length > 0) {
      const first = json.errors[0]!;
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
