# twenty-mcp

A thin external **Model Context Protocol** server that proxies Twenty CRM's in-tree `/mcp` endpoint and exposes:

- **`discovery`** — single read-only entry point. Agents call this to learn what tools exist (catalog) and to fetch full JSON Schemas on demand. Keeps agent context lean.
- **`search_records` / `get_record` / `create_record` / `update_record` / `delete_record`** — five convenience wrappers around Twenty's `execute_tool` for common record CRUD against any CRM object (built-in or custom).

All outbound calls go to a single Twenty endpoint (`POST <TWENTY_BASE_URL>/mcp`), so the proxy inherits Twenty's permission model, exclusion list, and progress notifications for free.

## Why this proxy exists

Twenty already ships an MCP server in-tree (`packages/twenty-server/src/engine/api/mcp/`) that uses a three-step discovery flow: `get_tool_catalog` → `learn_tools` → `execute_tool`. That's well-designed but verbose for agents — they have to learn the protocol before they can do anything.

This proxy collapses the three-step flow into one `discovery` tool and pre-bakes the five record-CRUD shortcuts every CRM-using agent eventually wants.

## Configuration

Copy `.env.example` to `.env` and fill in:

```dotenv
TWENTY_BASE_URL=http://localhost:4440      # the Twenty CRM URL
TWENTY_API_KEY=<workspace-api-key>          # Settings → Developers → API Keys in the Twenty UI
MCP_BIND=127.0.0.1                          # default; do not expose to 0.0.0.0 without a reverse proxy
MCP_PORT=4441
```

If Twenty has renamed any of the inner CRUD tools, set `TWENTY_MCP_INNER_TOOLS` to a JSON object with overrides:

```dotenv
TWENTY_MCP_INNER_TOOLS={"search":"crm.search.v2"}
```

## Run it

```bash
# from the repo root
npx nx build twenty-mcp
npx nx start twenty-mcp
# → [twenty-mcp] listening on http://127.0.0.1:4441/mcp → http://localhost:4440/mcp
```

Or directly with node:

```bash
cd packages/twenty-mcp && node lib/index.js
```

## Inspect with the official MCP inspector

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:4441/mcp
```

You should see six tools: `discovery`, `search_records`, `get_record`, `create_record`, `update_record`, `delete_record`. Try:

- `discovery({})` → catalog summary
- `discovery({focus: "search_records"})` → full schema
- `search_records({ object: "people", limit: 5 })` → records

## Wire it into agents

### Claude Code (`<project>/.mcp.json`)

```json
{
  "mcpServers": {
    "twenty": {
      "type": "http",
      "url": "http://127.0.0.1:4441/mcp"
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "twenty": { "url": "http://127.0.0.1:4441/mcp" }
  }
}
```

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS)

Modern builds with native HTTP transport:

```json
{
  "mcpServers": {
    "twenty": {
      "url": "http://127.0.0.1:4441/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Older builds without HTTP transport — bridge via `mcp-remote`:

```json
{
  "mcpServers": {
    "twenty": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:4441/mcp"]
    }
  }
}
```

## Auth model

- **Outbound (proxy → Twenty):** `Authorization: Bearer ${TWENTY_API_KEY}` on every request — same scheme as `twenty-zapier`.
- **Inbound (agent → proxy):** binds to `127.0.0.1` by default. If you need to expose it on a network, put it behind a reverse proxy with auth — this v1 does not implement inbound auth itself.

## Tests

```bash
npx nx test twenty-mcp
npx nx typecheck twenty-mcp
```

## Design

Plans and retrospectives live in [plans/](./plans/):

- [initial-design.md](./plans/initial-design.md) — the original design (tool surface, wrapper architecture, agent config snippets)
- [crm-wrapper-audit-fix.md](./plans/crm-wrapper-audit-fix.md) — audit + patch for the CRM wrapper shape bugs
- [crm-wrapper-audit-fix-retrospective.md](./plans/crm-wrapper-audit-fix-retrospective.md) — what shipped, why it shipped, and the contract-test layer added so it can't recur
- [note-target-linking-fix.md](./plans/note-target-linking-fix.md) — `link_note_to_record` tool that bypasses Twenty's record-crud workflow gate via GraphQL `createOneNoteTarget`
- [note-target-linking-fix-retrospective.md](./plans/note-target-linking-fix-retrospective.md) — the gate didn't say what its name implied; lessons on multi-path APIs
