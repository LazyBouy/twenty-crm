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
 * HTTP client for Twenty's THREE endpoints:
 *  - POST /mcp        → JSON-RPC inner tools (discovery + CRM + execute_tool path; gated by canObjectBeManagedByWorkflow)
 *  - POST /metadata   → GraphQL for admin metadata (roles, permissions, api keys, object/field metadata) — `createOne<X>` convention
 *  - POST /graphql    → GraphQL for workspace data (per-object CRUD; system-object bypass for noteTarget/timelineActivity) — `create<X>` convention, NO `One` prefix
 *
 * /metadata and /graphql have DISJOINT mutation sets — picking the wrong one is bug #4
 * from plans/audit-and-safeguards.md. Callers of graphqlMutation MUST specify which
 * endpoint they target.
 *
 * All endpoints share the same workspace API key bearer auth.
 * Mirrors the Bearer-auth pattern used by packages/twenty-zapier/src/utils/requestDb.ts.
 */

export type GraphqlError = {
  message: string;
  extensions?: {
    code?: string;
    subCode?: string;
    userFriendlyMessage?: string;
  };
  path?: ReadonlyArray<string | number>;
};

export type GraphqlEndpoint = 'metadata' | 'graphql';

export class TwentyMcpClient {
  private readonly mcpEndpoint: string;
  private readonly metadataEndpoint: string;
  private readonly dataEndpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor({ baseUrl, apiKey, fetchImpl }: TwentyMcpClientOptions) {
    const trimmed = baseUrl.replace(/\/+$/, '');
    this.mcpEndpoint = `${trimmed}/mcp`;
    this.metadataEndpoint = `${trimmed}/metadata`;
    this.dataEndpoint = `${trimmed}/graphql`;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private graphqlEndpointFor(endpoint: GraphqlEndpoint): string {
    return endpoint === 'metadata' ? this.metadataEndpoint : this.dataEndpoint;
  }

  /**
   * Parse a JSON-RPC response from either:
   *   - a `Content-Type: application/json` body (non-streaming), OR
   *   - a `Content-Type: text/event-stream` body (Streamable HTTP transport)
   * The deployed Caddy-fronted proxy returns SSE; the local docker-compose
   * proxy can return either depending on Accept negotiation. We accept both.
   */
  private async parseJsonRpcResponse(
    response: Response,
  ): Promise<JsonRpcResponse<ToolsCallResult>> {
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const raw = await response.text();
      // SSE frames: lines beginning with `data: ` separated by blank lines.
      // We take the first frame whose JSON has a JSON-RPC shape with `result` or `error`.
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const body = line.slice(6).trim();
        if (!body) continue;
        try {
          const parsed = JSON.parse(body) as JsonRpcResponse<ToolsCallResult>;
          if (
            parsed &&
            (parsed.result !== undefined || parsed.error !== undefined)
          ) {
            return parsed;
          }
        } catch {
          // not all data lines are well-formed; skip and keep scanning
        }
      }
      throw new TwentyMcpClientError(
        `Twenty /mcp SSE response had no JSON-RPC frame with result or error (raw: ${raw.slice(0, 200)})`,
      );
    }

    return (await response.json()) as JsonRpcResponse<ToolsCallResult>;
  }

  async toolsCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolsCallResult> {
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
        // Accept both — the MCP Streamable HTTP transport may respond with either.
        Accept: 'application/json, text/event-stream',
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

    const json = await this.parseJsonRpcResponse(response);

    if (json.error) {
      throw new TwentyMcpClientError(
        json.error.message,
        json.error.code,
        json.error.data,
      );
    }

    if (!json.result) {
      throw new TwentyMcpClientError(
        'Twenty /mcp returned no result and no error',
      );
    }

    return json.result;
  }

  /**
   * Issue a GraphQL query or mutation against the chosen Twenty endpoint.
   *
   * Pass `endpoint: 'metadata'` for admin operations (roles, permissions, api keys,
   * object/field metadata) — these live on /metadata and use `createOne<X>` mutation names.
   *
   * Pass `endpoint: 'graphql'` for workspace data operations (per-object CRUD, system-object
   * bypass for noteTarget/timelineActivity) — these live on /graphql and use `create<X>`
   * mutation names (NO `One` prefix).
   *
   * Errors come back in the GraphQL `{errors: [...]}` envelope; we normalise to
   * TwentyMcpClientError so callers don't branch on transport.
   */
  async graphqlMutation<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    endpoint: GraphqlEndpoint = 'metadata',
  ): Promise<T> {
    const url = this.graphqlEndpointFor(endpoint);
    const response = await this.fetchImpl(url, {
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
        `Twenty /${endpoint} returned ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`,
        response.status,
      );
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: GraphqlError[];
    };

    if (json.errors && json.errors.length > 0) {
      const first = json.errors[0]!;
      const code = first.extensions?.code ?? first.extensions?.subCode;
      const message = first.extensions?.userFriendlyMessage ?? first.message;
      throw new TwentyMcpClientError(message, undefined, {
        code,
        errors: json.errors,
      });
    }

    if (json.data === undefined) {
      throw new TwentyMcpClientError(
        `Twenty /${endpoint} returned no data and no errors`,
      );
    }

    return json.data;
  }
}
