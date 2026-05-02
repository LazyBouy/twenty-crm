# Plan: twenty-mcp comprehensive audit + structural safeguards + CLAUDE.md

> Per your instruction, this plan opens with the audit findings and confidence numbers BEFORE the action plan. The scope of the action plan is derived from where the confidence is still below the bar.

---

## Section 1 — Live audit data (ground truth from the deployed VPS Twenty)

Run against `http://100.115.12.29/` using the API key + inbound token in `packages/twenty-mcp/.env`. Three introspection sweeps + one CRUD lifecycle.

### 1.1 Inner tool name verification (all 40 references → 100% live)

40 inner tool names referenced across `crm.ts`, `metadata.ts`, `views.ts`, `workflows.ts` were each resolved live via `discovery({focus: <name>})`. **40/40 returned a schema** — every wrapper-referenced inner tool exists on the deployed Twenty.

Includes the previously "unverified" view tools (`update_view_field`, `create_many_view_fields`, `update_view_filter`) and `create_many_relation_fields`. All real.

### 1.2 GraphQL mutation + input-type verification on `/metadata` (the access.ts surface)

Introspected `__schema { mutationType { fields } }` against `/metadata`. Cross-checked all 7 hand-authored mutation names + 7 input types from `access.ts`:

| Reference | On `/metadata`? |
|---|---|
| `createOneRole` mutation | ✅ EXISTS (the `One` prefix is correct here) |
| `updateOneRole` mutation | ✅ EXISTS |
| `upsertObjectPermissions` mutation | ✅ EXISTS |
| `upsertFieldPermissions` mutation | ✅ EXISTS |
| `sendInvitations` mutation | ✅ EXISTS |
| `createApiKey` mutation | ✅ EXISTS |
| `revokeApiKey` mutation | ✅ EXISTS |
| `CreateRoleInput` type | ✅ |
| `UpdateRoleInput` type | ✅ |
| `UpsertObjectPermissionsInput` type | ✅ |
| `UpsertFieldPermissionsInput` type | ✅ |
| `CreateApiKeyInput` type | ✅ |
| `RevokeApiKeyInput` type | ✅ |
| `SendInvitationsInput` type | n/a — `sendInvitations` uses `@Args()` spread, no wrapper type. Builder is correct. |

**access.ts is 100% green.** My earlier "4 HIGH RISK" verdict was a false positive caused by inferring from the noteTarget bug. **The `One` prefix convention IS correct on `/metadata` — but is NOT the universal convention.** That's the structural lesson.

### 1.3 GraphQL endpoint partition (the *real* root of bug #4)

`/metadata` and `/graphql` expose **different mutation sets**:

| Endpoint | Mutations | Notable contents |
|---|---|---|
| `/metadata` | 203 | role/permission/api-key/object-metadata mutations (all with `One` prefix where applicable). **Zero note mutations.** |
| `/graphql` | 292 | per-object workspace data CRUD. **20 note-related** including `createNoteTarget`, `updateNoteTarget`, `deleteNoteTarget`. **No `createOne…`** prefix on this endpoint. |

`createNoteTarget` exists on `/graphql`. `NoteTargetCreateInput` exists on `/graphql`. **Neither exists on `/metadata`.**

### 1.4 New bug discovered live: `link_note_to_record` is dead-on-arrival

```bash
$ curl … --data '{… "name": "link_note_to_record", "arguments": {…fake uuids…}}' …/mcp
event: message
data: {"result":{"content":[{"type":"text","text":"Unknown type \"NoteTargetCreateInput\"."}],"isError":true},"jsonrpc":"2.0","id":1}
```

Root cause: [twenty-mcp-client.ts:62](packages/twenty-mcp/src/twenty-mcp-client.ts#L62) hardcodes `client.graphqlMutation` to send to `/metadata`. The note-target mutation lives on `/graphql`. The wrapper sends the right SQL to the wrong database. **One-liner fix candidates listed in the action plan below.**

This is a brand-new bug that the static audit alone could NOT have surfaced — it required live introspection of *both* endpoints. The HIGH RISK / FALSE POSITIVE flip + this new bug is exactly why the user demanded live verification.

### 1.5 End-to-end invocation through the deployed proxy

| Tool | Result |
|---|---|
| `discovery({})` | ✅ 260 tools across 7 categories |
| `discovery({focus: <40 names>})` | ✅ all 40 succeeded |
| `search_records({object: "person", limit: 2})` | ✅ `success: true`, "Found 0 person records" |
| `search_records({object: "person", filter: {city: {like: "%a%"}}, limit: 2})` | ✅ `success: true`, post-fix filter spread works live |
| `create_record({object: "person", data: {name: {firstName, lastName}}})` | ✅ `success: true`, returned `id=c7dd…` |
| `search_records({…filter on uniq tag})` | ✅ found the just-created record |
| `update_record({id, data: {jobTitle: "Audit Subject"}})` | ✅ `success: true`, "Record updated successfully" |
| `delete_record({id})` | ✅ `success: true`, "Record soft deleted" |
| `link_note_to_record({…})` | ❌ **dies with "Unknown type NoteTargetCreateInput"** (bug #4) |

**Always-on surface (CRM CRUD + discovery): 7/7 working live. link_note_to_record: 1/1 broken.**

Gated tools (metadata + views + workflows + access — 26 of 37 total) have name + type verification (1.1, 1.2) but **no end-to-end live exercise** in this audit. They're gated behind `enableMetadata=true` so they don't fire in default deployments.

---

## Section 2 — Confidence (per dimension, current state)

> The user explicitly asked for >95% across all dimensions. Here are the actual numbers backed by 1.1–1.5.

| Dimension | Number | Evidence |
|---|---|---|
| **Static enumeration of hand-authored downstream refs** | **100%** | All 82 references from the original audit reread + cross-referenced; 4 previously-"inferred" factory locations confirmed via direct grep (factory file + line shown in 1.1). |
| **Live name verification (inner tools)** | **100%** | 40/40 verified live via `discovery({focus})` against deployed Twenty. |
| **Live name verification (GraphQL mutations + input types)** | **100%** | 7/7 mutations + 6/6 input types verified via introspection on the correct endpoint. The 7th input type (`SendInvitationsInput`) is correctly absent — that mutation uses spread args. |
| **Endpoint partition awareness** | **100%** | Confirmed `/metadata` vs `/graphql` mutation sets differ; the wrapper's `client.graphqlMutation` only ever hits `/metadata`. **This was the latent cause of bug #4.** |
| **End-to-end invocation — always-on surface (CRM + discovery)** | **100%** | 7/7 working live (full CRUD lifecycle on `person`). |
| **End-to-end invocation — `link_note_to_record`** | **0%** (broken) | Confirmed dead-on-arrival; needs the routing fix. |
| **End-to-end invocation — gated tools (metadata + views + workflows + access, 26 tools)** | **0%** | Names verified live; runtime invocation NOT exercised against the deployed Twenty. |
| **Combined end-to-end across all 37 registered tools** | **~22%** | 8/37 (7 CRM/discovery + the broken link_note). The gated 26 lift this to >95% only after Phase 3 work below. |

**Bottom-line confidence that production won't surface another bug of the same class TODAY (without further work):**
- For default-on usage paths: **~85%** (CRM CRUD + discovery proven; link_note broken but that's the only known one in the always-on surface)
- For `enableMetadata=true` paths: **~75%** (names verified, but end-to-end exercise missing — same risk class as the noteTarget routing bug, just less likely to fire because of endpoint partitioning, and impossible to be the "wrong mutation name" class because we live-verified all 7).

**To reach >95% on every dimension** the action plan below is required. **Specifically:**
1. Fix bug #4 (link_note_to_record routing) — restores always-on confidence to ~95%.
2. Live-fire every gated tool at least once against the deployed Twenty — lifts gated-path confidence to ~90%.
3. Add the structural safeguards (capture-graphql-schema + coverage test + endpoint-aware client) so future drift is caught at PR-time — lifts long-term confidence to ~95%+.

---

## Section 3 — The 4 bugs the audit revealed

| # | Severity | Status | Where |
|---|---|---|---|
| 1 | High (already fixed) | ✅ shipped | CRM `data:`/`filter:` wrapper forwarded as wrappers; should spread to flat fields |
| 2 | High (already fixed) | ✅ shipped | `noteTarget` blocked by `canObjectBeManagedByWorkflow` gate; bypassed via GraphQL transport |
| 3 | High (already fixed) | ✅ shipped | `createOneNoteTarget` mutation name → `createNoteTarget` (no `One` prefix) |
| **4** | **High (new — found by this audit)** | ❌ **BROKEN in production right now** | `client.graphqlMutation` hardcoded to `/metadata`; `createNoteTarget` lives on `/graphql`. `link_note_to_record` returns "Unknown type NoteTargetCreateInput" on every call. |

**Plus a structural defect** (not a single bug, but the cause of the bug class):
- The wrapper layer has no automated cross-check against deployed-Twenty schemas. Every reference is hand-authored. Mocks self-validate.

---

## Section 4 — `packages/twenty-mcp/CLAUDE.md` content (the institutional memory)

```markdown
# CLAUDE.md — twenty-mcp

This package is a thin external MCP proxy for Twenty CRM. Read this BEFORE
modifying anything in src/tools/ or shipping a new wrapper tool.

## What it is
- Streamable-HTTP MCP server on :4441
- Proxies Twenty's in-tree /mcp (record-crud path; gated by canObjectBeManagedByWorkflow)
- Bypasses the gate via Twenty's GraphQL endpoints for system objects
- 37+ typed wrappers: discovery, crm, note-targets, metadata, views, workflows, access

## Architecture invariants (memorise these)
1. Wrappers expose typed Zod schemas to agents but forward RAW shapes to Twenty.
2. THREE transports, NOT two:
   - `client.toolsCall('execute_tool', …)` → Twenty's /mcp (record-crud; gated)
   - `client.graphqlMutation(…)` against /metadata → admin/role/api-key/object-metadata (createOne<X> convention)
   - `client.graphqlMutation(…)` against /graphql → workspace data (per-object CRUD; create<X> convention, NO `One` prefix)
3. /metadata and /graphql have DISJOINT mutation sets. A mutation that exists on one does NOT exist on the other.
4. `additionalProperties: false` on every Twenty inner schema — wrapper MUST NOT forward keys Twenty doesn't accept.

## Lessons (from the 4 production bugs we shipped)
L1. Schemas live in the wrapped system, not the wrapper. Capture; don't transcribe.
L2. Mocks pass when the spec passes — that's not correctness. Need fixture/live validation.
L3. Don't invent fields on the wrapper that don't exist downstream.
L4. "Uncertain pending verification" = "broken until proven."
L5. Lock the contract before scaling the surface.
L6. Tool descriptions ARE the contract for LLMs. Audit them when schemas change.
L7. Wrapper-layer bugs cost every consumer; rigour is justified.
L8. GraphQL mutation names ARE schema. Introspect, don't infer from peer files or resolver factory method-keys.
L9. /metadata ≠ /graphql. Same query language, different schemas. Pick the right endpoint per object — system objects (notes, companies, people) live on /graphql; admin metadata (roles, api keys, object/field metadata) lives on /metadata.

## Before-shipping checklist (REQUIRED for every PR touching src/tools/)
- [ ] `scripts/capture-graphql-schema.ts` ran successfully against deployed Twenty (BOTH /metadata and /graphql)
- [ ] `scripts/capture-inner-schemas.ts` ran successfully
- [ ] `npx jest src/__tests__/coverage.test.ts` passes (every wrapper reference exists in fixtures, with the correct endpoint)
- [ ] `npx jest src/__tests__/contract.test.ts` passes
- [ ] If a NEW tool was added: a per-tool integration smoke was added AND it passed live with TWENTY_MCP_INTEGRATION=1
- [ ] Tool description was read with an LLM-consumer's eye (no implicit assumptions; references discovery({focus}) for authoritative schema)
- [ ] If the new tool is a GraphQL transport: confirmed the endpoint partition (does it belong on /metadata or /graphql?)

## Plans + retrospectives
See plans/ — every shipped fix has a plan + retrospective. READ THEM before adding similar functionality.

## Common pitfalls
- /metadata and /graphql have different mutations. Do not assume.
- /graphql does NOT use the `createOne<X>` prefix. /metadata DOES.
- System objects (isSystem: true) cannot be created via record-crud. Route via /graphql.
- Don't forward agent-facing keys (object, data, filter) to Twenty's flat-shape inner tools.
- The GraphQL schema is auto-generated per workspace; some types only exist after specific objects are present.
```

---

## Section 5 — Final action plan (scope sized to the confidence gaps above)

The work falls into **three blocks**, executed in order:

### Block A: Bug #4 routing fix + endpoint-aware client (LIFTS always-on confidence to >95%)

A1. **Make `client.graphqlMutation` endpoint-aware.** Add an `endpoint: 'metadata' | 'graphql'` parameter. Default `'metadata'` (preserves access.ts behaviour). [twenty-mcp-client.ts](packages/twenty-mcp/src/twenty-mcp-client.ts) currently has a single `graphqlEndpoint` private field; add a second.

A2. **Update [note-targets.ts](packages/twenty-mcp/src/tools/note-targets.ts)** to pass `endpoint: 'graphql'` to its `graphqlMutation` call. Verify against deployed proxy that `link_note_to_record` succeeds end-to-end.

A3. **Add a contract assertion** to [contract.test.ts](packages/twenty-mcp/src/__tests__/contract.test.ts): for every GraphQL builder, the test must capture which endpoint it would target and assert that endpoint matches the captured fixture (Block C below).

### Block B: Capture + cross-check infrastructure (LIFTS structural confidence permanently)

B1. **New `scripts/capture-graphql-schema.ts`** that introspects BOTH `/metadata` and `/graphql` and writes two fixtures: `fixtures/metadata-graphql.json` and `fixtures/data-graphql.json`. Each captures `mutationType.fields[*].{name, args, type}` + `types[*].{name, kind, inputFields, fields, enumValues}`.

B2. **Extend `scripts/capture-inner-schemas.ts`** to also dump the full `tools/list` (categories + names) → `fixtures/tools-catalog.json`.

B3. **Run all three captures** against the deployed VPS Twenty (URLs in `.env`). Commit the fixtures.

B4. **New `__tests__/coverage.test.ts`** that enforces:
   - Every literal `toolName: '<X>'` in `src/tools/*.ts` exists in `tools-catalog.json`. Fail with names + file:line.
   - Every GraphQL mutation in `src/tools/*.ts` is parsed; the operation name + input type names must exist in the fixture for the endpoint the wrapper targets. Fail with mismatches.
   - Every selection-set field in a wrapper's GraphQL response must exist on the type returned by that mutation per the fixture.

B5. **Tighten [contract.test.ts](packages/twenty-mcp/src/__tests__/contract.test.ts)** to validate forwarded payloads against the captured (not hand-authored) inner-tool schemas. Hand-authored `forbiddenTopLevel` invariants stay (they encode wrapper-specific rules); the `schema` blocks are overwritten by the capture script.

After Block B lands, **no new wrapper can ship a hand-authored name that doesn't exist on the deployed Twenty for the right endpoint**. This is the structural defect closed.

### Block C: Per-tool live-fire integration sweep (LIFTS gated-path confidence to >95%)

**Two `.env` files, gitignored, never co-exist as `.env`:**

```
packages/twenty-mcp/
├── .env.production    ← VPS credentials (read-only smoke ONLY; never destructive)
├── .env.local         ← local docker-compose Twenty (full sweep ALLOWED)
└── .env.example       ← committed; documents required keys
```

`.env.production` contents:
```
TWENTY_BASE_URL=http://100.115.12.29
TWENTY_API_KEY=<vps-api-key>
MCP_INBOUND_TOKEN=<vps-caddy-token>
```

`.env.local` contents:
```
TWENTY_BASE_URL=http://localhost:4440
TWENTY_API_KEY=<local-api-key>
MCP_BIND=127.0.0.1
MCP_PORT=4441
```

**Gitignore update:** root [.gitignore](.gitignore) already has `**/**/.env`. Extend with TWO lines so the variants are covered AND `.env.example` stays committed:

```gitignore
# already present
**/**/.env
# new — covers .env.local, .env.production, .env.staging, etc.
**/**/.env.*
# new — re-include the template (negation must come AFTER the broad ignore)
!**/**/.env.example
```

Verify post-edit with `git check-ignore -v packages/twenty-mcp/.env.local packages/twenty-mcp/.env.production packages/twenty-mcp/.env.example` — first two should be ignored, third should be tracked.

**Existing single `.env` migration:** the current `packages/twenty-mcp/.env` (which now holds the VPS credentials per recent edits) is renamed to `.env.production`. The local-dev path stops looking for plain `.env`.

**Loading the right file:**

Use `dotenv-cli` (already a dev dep candidate; ~30 KB) so the test command makes the choice explicit:

```bash
# local sweep (destructive ops permitted)
npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts

# VPS smoke (read-only)
npx dotenv -e .env.production -- jest src/__tests__/integration/vps-smoke.test.ts
```

Symmetric for the proxy itself when running from source: `npx dotenv -e .env.local -- node lib/index.js`.

**Test-side guards (defence-in-depth, since one wrong flag would still hit prod):**

- `round-trip.test.ts` (the destructive sweep) requires BOTH `MCP_INTEGRATION_DESTRUCTIVE_OK=1` AND a runtime check that `process.env.TWENTY_BASE_URL` does NOT match the VPS host. If it does, fail fast with a loud error.
- `vps-smoke.test.ts` requires `MCP_VPS_SMOKE=1` AND refuses to start if `MCP_INTEGRATION_DESTRUCTIVE_OK=1` is also set.
- `CLAUDE.md` documents both rules.

**Test loop (confirmed approach):**

The VPS workspace is treated as **production — no destructive ops there**. All write/destructive testing happens against a **fresh local docker-compose Twenty** (the `packages/twenty-docker/docker-compose.deploy.yml` stack). VPS gets only read-only smoke + the targeted `link_note_to_record` verification on already-existing records.

```
┌───────────────────────────────────────────────────────────────────────┐
│ DEV LOOP (where bugs are caught)                                      │
│                                                                       │
│  1. docker compose -f packages/twenty-docker/docker-compose.deploy.yml│
│       up -d        ← brings up LOCAL Twenty + worker + db + redis +   │
│                      proxy on localhost:4440 / 4441                   │
│  2. mint local API key from local Twenty UI                           │
│  3. point integration tests at TWENTY_BASE_URL=http://localhost:4440  │
│       MCP_INTEGRATION_DESTRUCTIVE_OK=1  ← only set locally            │
│  4. npx jest src/__tests__/integration --testTimeout 60000            │
│       runs all 37 wrappers including write-heavy ones                 │
│  5. iterate on fixes against the local stack until green              │
└───────────────────────────────────────────────────────────────────────┘
                              │
                  green tests └──→ ship via existing manual deploy:
                                     docker compose build mcp
                                     docker compose up -d mcp     (on VPS)
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│ POST-DEPLOY VERIFICATION (production smoke; no destructive ops)       │
│                                                                       │
│  TWENTY_BASE_URL=http://100.115.12.29 MCP_INBOUND_TOKEN=…             │
│  npx jest src/__tests__/integration/vps-smoke.test.ts                 │
│       only the read-only + link_note_to_record verification           │
└───────────────────────────────────────────────────────────────────────┘
```

C1. **Expand [round-trip.test.ts](packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts)** to one minimal exercise per registered tool. 37 tests total, gated by `TWENTY_MCP_INTEGRATION=1` + `INCLUDE_INTEGRATION=1`. **Destructive ops additionally gated by `MCP_INTEGRATION_DESTRUCTIVE_OK=1`** — `vps-smoke.test.ts` (Step C3) MUST NOT set this flag and MUST run on a separate `describe()` block.

| Family | Tools | Smoke shape | Local-only? |
|---|---|---|---|
| discovery | 1 | already covered | run on both |
| crm | 5 | already covered (lifecycle on `person`) — add same on `company` | run on local; read-only ones on VPS |
| note-targets | 1 | post-fix lifecycle: create note → create company → link → verify on noteTargets relation → cleanup | local only (writes); VPS gets a single read-only verification using existing records |
| metadata read | 6 | `metadata_query({kind: …})` for objects/fields/views/view_fields/view_filters/view_sorts | run on both |
| metadata write | 7 | create_object → create_field → update_field → create_relation → delete (cleanup) | **local only** |
| views | 8 | create_view → field/filter/sort lifecycle on the test view → cleanup | **local only** |
| workflows | 7 | create_complete (DRAFT, no activate) → step + edge → cleanup | **local only** |
| access | 7 | metadata_query roles (read-only on both); create_role → revoke_api_key on test data — local only | **writes local only** |

C2. **New `__tests__/integration/vps-smoke.test.ts`** — deliberately read-only sweep + the targeted post-deploy verifications (`link_note_to_record` against an existing test note + company that we maintain in the VPS workspace specifically for this). Gated by `TWENTY_MCP_INTEGRATION=1` + `MCP_VPS_SMOKE=1`. **Refuses to run if `MCP_INTEGRATION_DESTRUCTIVE_OK=1` is set** (defence in depth — a misconfigured env can't accidentally write to prod).

C3. **Document in CLAUDE.md** that **VPS is production**: no destructive ops; only the curated `vps-smoke.test.ts` runs there; full sweep runs against local docker-compose Twenty before any deploy.

**No CI/CD pipeline in scope for this audit.** A future enhancement could add a GitHub Actions workflow that auto-runs the local docker-compose sweep on every PR, but that's a separate project. The audit deliberately keeps the dev loop manual + reproducible.

### Block D: Description + CLAUDE.md + retrospective

D1. **Description audit pass** — re-read every tool description with an LLM-consumer lens. Specific known issues:
   - [access.ts:335](packages/twenty-mcp/src/tools/access.ts#L335) Admin role hardcoded by label — document explicitly
   - [metadata.ts:492](packages/twenty-mcp/src/tools/metadata.ts#L492) webhooks query — verify exists or remove the kind
   - [views.ts:247](packages/twenty-mcp/src/tools/views.ts#L247) KANBAN field-type validation gap — document explicitly

D2. **Create `packages/twenty-mcp/CLAUDE.md`** with the content sketched in Section 4.

D3. **Plan + retrospective files**:
   - Copy this plan verbatim to `plans/audit-and-safeguards.md`
   - Write `plans/audit-and-safeguards-retrospective.md` after Blocks A–C land, capturing the final achieved % vs predicted

D4. **Update [README.md](packages/twenty-mcp/README.md)** to link CLAUDE.md + the new plan/retrospective.

### Verification

```bash
cd packages/twenty-mcp

# ─── Block B: captures (read-only against VPS — safe) ─────────────────
npx dotenv -e .env.production -- npx tsx scripts/capture-graphql-schema.ts
npx dotenv -e .env.production -- npx tsx scripts/capture-inner-schemas.ts --object person

# ─── Block A + B: static + contract tests pass green (no Twenty needed) ─
npx tsc --noEmit
npx jest src/__tests__/coverage.test.ts    # cross-checks vs captured fixtures
npx jest src/__tests__/contract.test.ts
npx jest --testTimeout 10000               # full unit suite

# ─── Block C: full local sweep (destructive ops on LOCAL Twenty) ─────
cd ../twenty-docker
docker compose -f docker-compose.deploy.yml up -d
# mint local API key from http://localhost:4440 → Settings → Developers
# write it into packages/twenty-mcp/.env.local (gitignored)
cd ../twenty-mcp
MCP_INTEGRATION_DESTRUCTIVE_OK=1 INCLUDE_INTEGRATION=1 TWENTY_MCP_INTEGRATION=1 \
  npx dotenv -e .env.local -- \
  jest src/__tests__/integration/round-trip.test.ts --testTimeout 60000
# expect: 37/37 pass (or fewer — each failure is a real bug to fix locally first)
# defence-in-depth: the suite also verifies TWENTY_BASE_URL is not the VPS host

# ─── Deploy to VPS (only after local is green) ────────────────────────
cd ../twenty-docker
docker compose -f docker-compose.deploy.yml build mcp
# manual ship to VPS via existing process (scp / docker registry / etc.)
# then on VPS:
#   docker compose -f docker-compose.deploy.yml up -d mcp

# ─── Post-deploy: read-only smoke against VPS (no destructive ops) ───
cd packages/twenty-mcp
MCP_VPS_SMOKE=1 INCLUDE_INTEGRATION=1 TWENTY_MCP_INTEGRATION=1 \
  npx dotenv -e .env.production -- \
  jest src/__tests__/integration/vps-smoke.test.ts --testTimeout 30000
# expect: discovery + read-only metadata + link_note_to_record on pre-seeded
# test records all return success: true
# defence-in-depth: vps-smoke refuses to run if MCP_INTEGRATION_DESTRUCTIVE_OK=1
```

Rollback: `git revert <audit-commit>` then rebuild + redeploy on VPS. Underlying CRM data on VPS untouched throughout (no destructive tests ever fire there).

---

## Out of scope (deliberate)

- **Patching twenty-server.** The actor-source hardcoding from the noteTarget retrospective remains the correct upstream fix; track as a separate PR. This audit treats deployed Twenty as immutable.
- **Generic dynamic-discovery refactor** (proxy auto-discovers tool names at startup from `tools/list`). Bigger redesign; defer until Block B fixtures stable.
- **Removing convenience wrappers in favour of `discovery + execute_tool`.** Wrapper UX is the value-add; fix is to make them correct, not remove them.

---

## Confidence after each block lands

| Stage | Always-on % | Gated % | Structural % |
|---|---|---|---|
| Today (after this audit alone, no fix) | 85 | 75 | 30 |
| After Block A (route fix + endpoint-aware client) | 95 | 75 | 30 |
| After Block B (capture + coverage tests in CI) | 95 | 80 | 95 |
| After Block C (per-tool live-fire) | 96 | 95 | 95 |
| After Block D (descriptions + CLAUDE.md + retrospective) | 96 | 95 | 96 |

**Why I'm capping at ~96% even after all blocks:**
1. Twenty is a third-party we don't control — its schema can shift between captures
2. Live smoke is happy-path; production agents stress unusual inputs
3. Workflows + bulk operations have rich loose-typed structures Zod can't fully constrain
4. Capture-time vs runtime drift is irreducible; daily/weekly drift detection (a CI job) gets us closer to 99% but adds operational complexity

**Recommendation:** Block A immediately (it's a one-line wrapper change to fix a known broken tool); Block B in same cycle (the structural fix); Block C+D in the same audit window so we don't ship a fifth bug while patching the fourth.
