# Plan: External Twenty-CRM MCP server (`packages/twenty-mcp`)

## Context

The user wants a **thin external MCP server** that proxies Twenty's already-shipped in-tree MCP endpoint (`POST /mcp` at `packages/twenty-server/src/engine/api/mcp/`). The in-tree server exposes a 3-step discovery flow (`get_tool_catalog` → `learn_tools` → `execute_tool`) plus `load_skill` and a small set of preloaded tools — well-designed but verbose for agents.

Goals:
1. **One `discovery` entry point** that collapses Twenty's three discovery primitives into a single tool — agents don't need to know the multi-step shape.
2. **A small set of essential CRM tools** (5 convenience wrappers around `execute_tool`) so agents can do common record CRUD without round-tripping through discovery first.
3. **Streamable HTTP transport** so the server is deployable alongside the docker-compose CRM (likely on `:4441`) and reachable by any MCP-aware agent.
4. **Sample agent configs** (Claude Desktop, Claude Code, Cursor) shipped alongside the README.
5. **Keep agent context lean** — discovery returns lists by default and only emits full JSON Schemas when a specific tool is named.

The five+ existing community Twenty MCP servers (mhenry3164, jezweb, Jdu278, hbergum, denisalmeida) all reimplement CRM CRUD against Twenty's REST/GraphQL — none proxy the in-tree `/mcp`. Proxying it inherits Twenty's permission model, exclusion list, role-based filtering, and progress notifications for free.

## Architecture

```
┌─────────────┐   MCP/HTTP+SSE   ┌────────────────────┐   JSON-RPC/HTTP   ┌──────────────────┐
│ Agent (e.g. │ ───────────────► │ packages/twenty-mcp│ ────────────────► │ Twenty server    │
│ Claude Code)│ ◄─────────────── │ (Streamable HTTP)  │ ◄──────────────── │ POST /mcp        │
└─────────────┘                   └────────────────────┘                   └──────────────────┘
                                          │
                                  exposes 6 tools:
                                  - discovery
                                  - search_records
                                  - get_record
                                  - create_record
                                  - update_record
                                  - delete_record
```

The proxy is genuinely thin:
- All outbound calls go to Twenty's `/mcp` (no direct REST/GraphQL reads — keeps a single auth + permission path).
- The 5 CRUD tools are not new functionality; they're hardcoded shortcuts for `execute_tool` against well-known preloaded tool names.
- `discovery` is the only tool that *combines* multiple in-tree calls.

## Package layout

New Nx package at `packages/twenty-mcp/`:

```
packages/twenty-mcp/
├── package.json              # name: "twenty-mcp"; bin: "twenty-mcp"
├── project.json              # nx targets: build, start, lint, test, typecheck
├── tsconfig.json             # extends repo base
├── jest.config.ts
├── README.md                 # usage + sample agent configs
├── PLAN.md                   # verbatim copy of this plan (design lives next to the code)
├── .env.example              # TWENTY_BASE_URL, TWENTY_API_KEY, MCP_PORT, MCP_BIND
└── src/
    ├── index.ts              # entrypoint: parse env → start server
    ├── server.ts             # @modelcontextprotocol/sdk Server + StreamableHTTPServerTransport
    ├── config.ts             # zod-validated env loader
    ├── twenty-mcp-client.ts  # HTTP client for Twenty's POST /mcp (JSON-RPC + Bearer)
    ├── tools/
    │   ├── discovery.ts      # the unified discovery tool
    │   └── crm.ts            # search_records / get_record / create_record / update_record / delete_record
    └── __tests__/
        ├── discovery.test.ts
        ├── crm.test.ts
        └── twenty-mcp-client.test.ts
```

Dependencies (additions to root `package.json`):
- `@modelcontextprotocol/sdk` (current 1.x)
- `zod` (already used elsewhere in the repo)
- Dev: `@types/node`, jest already present
- Will *not* depend on `twenty-client-sdk` — we only talk to `/mcp`, not GraphQL/REST directly. Keeps the package small and decoupled from Twenty's release cycle.

## Tool surface (the 6 tools the external server exposes)

### 1. `discovery` — single progressive entry point

```ts
discovery({
  query?: string,        // free-text filter on name/description; empty → top-level catalog
  focus?: string,        // a specific tool name → return its full input schema
  category?: string,     // optional category filter when listing
})
```

Behavior:
- `discovery({})` → calls in-tree `get_tool_catalog` with no filter, returns a brief summary: list of categories, ~5 example tool names per category, total tool count, and a one-liner instructing the agent to call `discovery({focus: "<name>"})` for schemas. Target output: <2 KB.
- `discovery({query: "person"})` → calls `get_tool_catalog`, post-filters by substring match on name/description. Returns name + 1-line description per match. No schemas.
- `discovery({focus: "<tool_name>"})` → calls in-tree `learn_tools(["<tool_name>"])` and returns the JSON Schema verbatim. This is the only path that emits full schemas.
- `discovery({category: "records"})` → list category contents only.

Discovery is **read-only** by design — it never invokes tools. Invocation goes through the convenience tools below or through a future explicit `invoke` tool. This keeps the contract unambiguous and prevents "I called discovery and it ran something" surprises.

### 2–6. CRM convenience tools (all wrap `execute_tool` underneath)

```ts
search_records({ object: string, query?: string, filter?: object, limit?: number, fields?: string[] })
get_record({ object: string, id: string, fields?: string[] })
create_record({ object: string, data: object })
update_record({ object: string, id: string, data: object })
delete_record({ object: string, id: string })
```

Each maps onto a corresponding preloaded tool inside Twenty's `COMMON_PRELOAD_TOOLS` registry (e.g., `search_records` → `crm_search_records` or whatever the in-tree name is — to be confirmed at impl time by calling `tools/list` once during dev). The wrapper:
1. Builds the JSON-RPC `tools/call` payload for `execute_tool` with `{ name: "<inner_tool>", arguments: {...} }`.
2. POSTs to `${TWENTY_BASE_URL}/mcp` with `Authorization: Bearer ${TWENTY_API_KEY}` and `Accept: application/json, text/event-stream`.
3. Streams progress notifications back to the external client over its own SSE channel (Twenty already emits these per `mcp-progress-notification.const.ts`).
4. Returns the result content unchanged.

Errors map JSON-RPC error codes → MCP `isError: true` content blocks with the original code/message preserved.

## Auth model

**Outbound (proxy → Twenty):** `TWENTY_API_KEY` env var (workspace API key, same scheme as `twenty-zapier`). Header: `Authorization: Bearer ${TWENTY_API_KEY}`. Pattern verified at `packages/twenty-zapier/src/utils/requestDb.ts`.

**Inbound (agent → proxy):** v1 binds to `127.0.0.1` by default. Documented config knob `MCP_BIND=0.0.0.0` for shared deployments — but this requires an MCP-level token, so v1 leaves multi-tenant auth out of scope. README will explicitly say "for v1 run on localhost or behind a trusted reverse proxy."

The in-tree server already implements full RFC 9728 OAuth scope discovery; reimplementing inbound OAuth here would duplicate that. A later v2 can add a `MCP_AUTH_TOKEN` shared-secret check.

## Configuration

`.env.example`:
```
# Where the Twenty server's MCP endpoint lives.
# For the docker-compose deployment from earlier, this is http://localhost:4440
TWENTY_BASE_URL=http://localhost:4440

# Workspace API key. Generate from Twenty UI: Settings → Developers → API Keys.
TWENTY_API_KEY=

# This MCP server's bind address & port.
MCP_BIND=127.0.0.1
MCP_PORT=4441
```

Validated at startup via `zod`; missing required fields → fail fast with a clear message.

## Sample agent configs (shipped in README)

**Claude Code** (`<project>/.mcp.json`):
```json
{
  "mcpServers": {
    "twenty": {
      "type": "http",
      "url": "http://localhost:4441/mcp"
    }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, equivalent path on Linux/Windows):
```json
{
  "mcpServers": {
    "twenty": {
      "url": "http://localhost:4441/mcp",
      "transport": "streamable-http"
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "twenty": { "url": "http://localhost:4441/mcp" }
  }
}
```

README will note that older Claude Desktop builds still need stdio + the `mcp-remote` shim — example will be included as a fallback.

## Critical files to read (existing — do NOT modify)

- `packages/twenty-server/src/engine/api/mcp/controllers/mcp-core.controller.ts` (lines 33–113) — the `/mcp` JSON-RPC contract we're calling.
- `packages/twenty-server/src/engine/api/mcp/services/mcp-protocol.service.ts` (lines 100–162) — confirms the exposed tool names: `get_tool_catalog`, `learn_tools`, `execute_tool`, `load_skill`, plus `COMMON_PRELOAD_TOOLS`.
- `packages/twenty-server/src/engine/api/mcp/constants/mcp-server-info.const.ts` — protocol version & server info we should report compatible with.
- `packages/twenty-server/src/engine/api/mcp/constants/mcp-excluded-tool-names.const.ts` — tools the in-tree server hides; we mirror this exclusion behavior so `discovery` doesn't list them.
- `packages/twenty-server/src/engine/api/mcp/utils/write-sse-event.util.ts` — SSE format reference.
- `packages/twenty-zapier/src/utils/requestDb.ts` — canonical Bearer-auth POST pattern to copy for the outbound HTTP client.
- `packages/twenty-server/src/engine/core-modules/tool-provider/services/tool-registry.service.ts` (lines 25–100+) — the `getCatalog` / `resolveSchemas` shape that `get_tool_catalog` and `learn_tools` ultimately return; informs the discovery output format.

## Out of scope (explicitly not in v1)

- Direct REST/GraphQL access to Twenty (everything goes through `/mcp`).
- Inbound auth on the proxy itself beyond localhost binding.
- Bundling the proxy as a Docker service in `docker-compose.deploy.yml` — README will document the optional Dockerfile but not auto-wire it.
- A demo end-to-end agent script — defer to a follow-up; user only requested config snippets as the "client" deliverable.
- `load_skill` passthrough — out of scope for v1; can be added as a 7th tool later.

## Verification

1. **Unit tests** (mock Twenty `/mcp` with `nock` or `msw`):
   - `discovery({})` → asserts the outbound payload is `tools/call` with name `get_tool_catalog`, returns a summary under 2 KB.
   - `discovery({focus: "search_records"})` → asserts outbound is `tools/call` with name `learn_tools`, returns the schema verbatim.
   - Each CRM tool → asserts outbound is `tools/call` with name `execute_tool` and the correct inner tool name + arguments.
   - Auth: every outbound request carries `Authorization: Bearer <key>`.
   - Error mapping: a JSON-RPC error response from Twenty surfaces as MCP `isError: true` content.

2. **Integration smoke** against the local docker-compose CRM (port 4440 from the earlier plan):
   ```bash
   # Bring up Twenty
   docker compose -f packages/twenty-docker/docker-compose.deploy.yml up -d

   # Mint a workspace API key in the UI (Settings → Developers → API Keys), then:
   echo "TWENTY_API_KEY=<key>" >> packages/twenty-mcp/.env

   # Start the proxy
   npx nx start twenty-mcp

   # In a second terminal, drive it with the official MCP inspector
   npx @modelcontextprotocol/inspector http://localhost:4441/mcp
   #   → expect 6 tools listed
   #   → call discovery({})       → catalog summary
   #   → call discovery({focus: "search_records"}) → schema
   #   → call search_records({ object: "people", limit: 5 }) → records
   ```

3. **Agent config smoke**: drop the Claude Code snippet into a scratch repo's `.mcp.json`, open Claude Code, ask "use the twenty MCP to find a person named X" — confirm it discovers + searches without bloating the conversation.

4. **Lint + typecheck + tests** before declaring done:
   ```bash
   npx nx lint twenty-mcp
   npx nx typecheck twenty-mcp
   npx nx test twenty-mcp
   ```
