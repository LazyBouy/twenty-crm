# Plan: Replace wrapper name inference with server-side metadata fetch (embedded acronyms + mass nouns)

> Issue(s): #12 (grouped: #13)
> Package: packages/twenty-mcp
> Severity: medium
> Worst-case bug class if deferred: Tested-because-mock-passes / L1 (wrapper infers what the server emits; diverges silently for any camelCase input the local inference logic doesn't handle — same class as the 1.1M-token data-wrapper bug)
> Created: 2026-05-12

## Problem statement

`packages/twenty-mcp/src/tools/crm.ts` `normalize()` (lines 29–46) derives inner-tool names by (1) applying a regex `([a-z0-9])([A-Z])` to insert underscores at camelCase boundaries, then (2) calling `pluralize.singular` / `pluralize.plural` to get singular/plural forms. Two independent bugs survive issue #11's regex fix:

**#12 — embedded acronyms**: the regex only inserts ONE underscore at the first lowercase→capital boundary; server's `camelToSnakeCase` inserts before EVERY capital via `/[A-Z]/g`. For `iOSDevice`, wrapper produces `i_osdevice`, server registers `i_o_s_device`. Any workspace with a custom object whose `nameSingular` matches `/^[a-z][a-zA-Z0-9]*$/` with embedded consecutive capitals (e.g. `iOSDevice`, `myAPIKey`, `userIPAddress`) suffers a "Tool not found" failure on every CRUD wrapper call.

**#13 — mass nouns**: `pluralize.singular('company_analytics')` returns `'company_analytic'`; the server stores both `nameSingular` and `namePlural` explicitly in `objectMetadata` and never calls `pluralize` at all — it registers `create_company_analytics` using `camelToSnakeCase(nameSingular)` directly. Any object whose Twenty-stored `nameSingular` ends in a mass-noun stem (`analytics`, `data`, `metadata`, `news`, `series`, `statistics`, `physics`, `economics`, `species`, `means`, `mathematics`, `politics`) silently routes singular CRUD operations to a non-existent tool name.

Both bugs share an identical root cause (local inference diverges from server-stored ground truth) and an identical structural fix (fetch `nameSingular`/`namePlural` from the server at call time and apply `camelToSnakeCase` directly, eliminating `pluralize` entirely).

## Reproduction

**#12 — embedded acronyms (unit, no live stack needed):**
```bash
cd packages/twenty-mcp
node -e "
const { innerToolName } = require('./dist/tools/crm');
// or via ts-node:
"
# Faster: add a test assertion and run the unit suite
# In packages/twenty-mcp/src/__tests__/crm.test.ts, add:
#   expect(innerToolName('search', 'iOSDevices')).toBe('find_i_o_s_devices');
# Then run:
npx jest src/__tests__/crm.test.ts --config jest.config.ts
# Expected: FAIL — received 'find_iosdevices', expected 'find_i_o_s_devices'
```

**#13 — mass nouns (unit, no live stack needed):**
```bash
# The existing test already documents the bug:
cd packages/twenty-mcp
npx jest src/__tests__/crm.test.ts --config jest.config.ts \
  --testNamePattern="pluralize-mass-noun"
# 'documents pluralize-mass-noun limitation' passes (asserts the BUGGY output
# 'create_company_analytic', which the server does NOT register).
```

**Live repro (requires running stack at localhost:4440 / localhost:4441):**

The supervisor has confirmed the stack is up. Create a custom object with an embedded-acronym name:
```bash
curl -sX POST "http://localhost:4440/metadata" \
  -H "Authorization: Bearer $TWENTY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { createOneObject(input:{nameSingular:\"myAPIKey\",namePlural:\"myAPIKeys\",labelSingular:\"My API Key\",labelPlural:\"My API Keys\",icon:\"IconKey\"}) { id } }"}'
# Then via MCP:
curl -sX POST "http://localhost:4441/mcp" \
  -H "Authorization: Bearer $TWENTY_API_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_records","arguments":{"object":"myAPIKeys","limit":5}}}'
# Expected (before fix): Tool "find_myapikeys" not found
# Expected (after fix): success: true, records: []
```

## Root cause hypothesis

**#12 root cause** — `packages/twenty-mcp/src/tools/crm.ts:37–41`:
```typescript
const snakeified = object
  .trim()
  .replace(/\s+/g, '_')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')   // ← only matches lowercase→capital transition
  .toLowerCase();
```
The regex `/([a-z0-9])([A-Z])/g` requires a lowercase or digit BEFORE the capital to insert an underscore. For `iOSDevice`, after matching `i` + `O` it produces `i_OSDevice`; the `O`→`S` and `S`→`D` transitions are capital→capital so the regex never fires again, yielding `i_osdevice`. Server's `camelToSnakeCase` (`packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts:1`) uses `/[A-Z]/g` — it matches EVERY capital regardless of context — producing `i_o_s_device`.

**#13 root cause** — `packages/twenty-mcp/src/tools/crm.ts:43–45`:
```typescript
return {
  singular: pluralize.singular(snakeified),   // ← pluralize.singular mishandles mass nouns
  plural: pluralize.plural(snakeified),
};
```
The server (`packages/twenty-server/src/engine/core-modules/tool-provider/providers/database-tool.provider.ts:117–118`) does:
```typescript
const snakePlural = camelToSnakeCase(objectMetadata.namePlural);
const snakeSingular = camelToSnakeCase(objectMetadata.nameSingular);
```
It uses the explicitly-stored `nameSingular` and `namePlural` from `objectMetadata` — NO inference from `pluralize`. The wrapper has no mechanism to obtain these values; it infers them, which diverges wherever `pluralize`'s inference disagrees with the human-chosen `nameSingular`/`namePlural` at object creation time.

**Shared structural root cause**: the wrapper applies two local inference steps (regex-based camelCase split + pluralize library) to reconstruct what the server stores directly. Any inference gap produces a "Tool not found" error at the point of a CRUD call, with no actionable error message distinguishing "wrong tool name" from "object does not exist".

**Convergent fix**: `metadata_query({kind: 'objects'})` already exists as a wrapper tool (`packages/twenty-mcp/src/tools/metadata.ts`) and returns the full `objectMetadata` list including `nameSingular`, `namePlural`, and the server-registered tool names. The `normalize()` function should be replaced by a lookup that fetches `{nameSingular, namePlural}` from server metadata (via an API call on first use) and applies `camelToSnakeCase` directly to both — eliminating both the regex and `pluralize` gaps simultaneously.

## Proposed fix

### Overview

Replace `normalize()` in `packages/twenty-mcp/src/tools/crm.ts` with a two-phase approach:

1. **Resolve phase**: given an agent-supplied object name (any casing/form), call `metadata_query({kind: 'objects'})` once per CRUD handler invocation to resolve the authoritative `{nameSingular, namePlural}` from `objectMetadata`. Match the agent's input against `nameSingular`, `namePlural`, their snake-cased equivalents, and their lowercased equivalents — whichever matches first wins.

2. **Name-construction phase**: apply `camelToSnakeCase` (imported from `twenty-shared`) to the resolved `nameSingular` / `namePlural` directly. Do NOT call `pluralize` for name construction. The server-stored values ARE the canonical singular/plural forms.

### Detailed changes

**File 1: `packages/twenty-mcp/src/tools/crm.ts`**

- Remove `import pluralize from 'pluralize'` (line 1).
- Add `import { camelToSnakeCase } from 'twenty-shared/utils'` — verify `twenty-mcp/package.json` already has `twenty-shared` as a dependency (see dependency note below).
- Replace `normalize()` with `resolveObjectNames(client: TwentyMcpClient, input: string): Promise<{nameSingular: string; namePlural: string}>`. This function:
  1. Calls `client.toolsCall('metadata_query', {kind: 'objects'})` to get the workspace's `objectMetadata` list.
  2. Parses the result via `parseInnerOrGraphqlArray` (already used in `round-trip.test.ts`).
  3. Matches `input` (after `.trim().toLowerCase()`) against each object's `nameSingular`, `namePlural`, `camelToSnakeCase(nameSingular)`, and `camelToSnakeCase(namePlural)` — all lowercased for case-insensitive matching.
  4. Returns `{nameSingular, namePlural}` of the matching object.
  5. If no match: throws a descriptive error — `"Object '${input}' not found in workspace. Available objects: [${names.join(', ')}]. Use discovery({focus: 'find_...'}) to inspect schemas."` (preserves current UX for mistyped names; avoids silent wrong routing).
- Replace `innerToolName()` with a synchronous `buildToolName(op, snakeSingular, snakePlural)` that takes already-resolved snake forms — `innerToolName` was the public API of the old regex-based path; the new flow is async so callers must `await resolveObjectNames` first.
- Update all five handler functions in `buildCrmHandlers` to `await resolveObjectNames(client, args.object)` then call `camelToSnakeCase(nameSingular)` / `camelToSnakeCase(namePlural)` to build the inner tool name.

**File 2: `packages/twenty-mcp/package.json`**

- Verify whether `twenty-shared` is already listed in `dependencies`. If not, add `"twenty-shared": "*"` (matching workspace peers) and run `yarn install`.

**File 3: `packages/twenty-mcp/src/__tests__/crm.test.ts`**

- The existing `innerToolName` unit tests rely on the old synchronous API. Since `innerToolName` is being removed/replaced by an async path, these tests must be refactored to either (a) test the new `buildToolName(op, snakeSingular, snakePlural)` helper directly (for the pure name-construction part), or (b) mock `client.toolsCall` to return a fixture metadata response and test the full async resolution path.
- Add test cases for embedded-acronym names: `{nameSingular: 'iOSDevice', namePlural: 'iOSDevices'}` — expect `find_i_o_s_devices`, `create_i_o_s_device`, etc.
- Add test cases for mass-noun names: `{nameSingular: 'companyAnalytics', namePlural: 'companyAnalytics'}` — expect `find_company_analytics`, `create_company_analytics`, etc.
- Remove or update the "documents pluralize-mass-noun limitation" test (the bug it documents is now fixed).
- Update the "handles camelCase multi-word object names (issue #11)" test to reflect the new async API shape.

**File 4: `packages/twenty-mcp/src/__tests__/crm-coverage.test.ts`**

- The existing coverage test asserts `normalize()` matches `camelToSnakeCase` for a curated camelCase input list. After this fix, the name-construction path IS `camelToSnakeCase` directly (no separate regex to verify) — the coverage test's signature-regex gate and equivalence loop become a tautology.
- Repurpose the file to test the `resolveObjectNames` resolution logic against a mocked metadata response: assert that various input forms (plural, singular, PascalCase, snake_cased, already-lowercased) all resolve to the correct `{nameSingular, namePlural}` from the mock object list. This is the new drift gate: resolution logic correctness.
- Add cases for: embedded-acronym inputs, mass-noun inputs, ambiguous inputs (where both `nameSingular` and `namePlural` could match — pick singular), case-insensitive match.

**File 5: `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts`**

- The existing `integration: multi-word custom object CRUD (issue #11)` block already provides end-to-end coverage for the basic camelCase case (`mcpAuditFixture`). Extend it with two new sub-blocks:
  1. `integration: embedded-acronym custom object CRUD (issue #12)` — creates `myAPIKeyFixture` / `myAPIKeyFixtures`, runs search/create/get/update/delete, then deletes the fixture. Confirms `find_my_a_p_i_key_fixtures` routes correctly.
  2. `integration: mass-noun custom object CRUD (issue #13)` — creates `companyAnalyticsFixture` / `companyAnalyticsFixtures` (or a simpler mass-noun stem that Twenty accepts), runs search/create, confirms the singular ops route to `create_company_analytics_fixture` not `create_company_analytic_fixture`.

### Dependency note

Check `packages/twenty-mcp/package.json` before writing the import:
```bash
grep -i "twenty-shared" packages/twenty-mcp/package.json
```
Issue #11's plan noted that `twenty-mcp` did NOT depend on `twenty-shared` as of that plan's writing (this was offered as a reason to avoid the import). Verify the current state before coding the import. If it is absent, add it to `dependencies` and run `yarn install` within the session. The structural concern raised in issue #11's "Out of scope" section (adding `twenty-shared` is "a structural change with broader implications") is the wrong framing per R5 — the consequence of NOT adding it is the two bugs under plan; the consequence of adding it is a dependency declaration in `package.json` and a minor compile-time coupling. The dependency is already in-monorepo so no version resolution is required.

### Performance note

The metadata fetch adds one network round-trip per CRUD call. On the local stack this is ~5–10 ms. Caching is out of scope for this plan (the metadata list changes rarely; a simple in-process TTL cache is a follow-up). The behaviour-correctness win far outweighs the latency cost for an MCP proxy. Flag this in the plan's Out of scope section for the implementer to acknowledge.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] **Dependency check**: `grep -i "twenty-shared" packages/twenty-mcp/package.json` — if absent, add and run `yarn install`; confirm no package resolution errors.

- [ ] **Unit — name construction (pure, no network)**:
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/crm.test.ts --config jest.config.ts
  ```
  Expected: all tests pass. Must include: `buildToolName('search', 'i_o_s_device', 'i_o_s_devices')` → `'find_i_o_s_devices'`; `buildToolName('create', 'company_analytics', 'company_analytics')` → `'create_company_analytics'`.

- [ ] **Unit — resolution logic (mocked metadata, no network)**:
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/crm-coverage.test.ts --config jest.config.ts
  ```
  Expected: all tests pass. Must cover: embedded-acronym input `'iOSDevices'` resolves to `{nameSingular: 'iOSDevice', namePlural: 'iOSDevices'}`; mass-noun input `'companyAnalytics'` resolves to `{nameSingular: 'companyAnalytics', namePlural: 'companyAnalytics'}`; unrecognised input throws with the expected "not found" message including the available-objects list.

- [ ] **Unit — wire-level payload assertions (mocked client)**:
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/crm.test.ts --config jest.config.ts \
    --testNamePattern="CRM convenience tools"
  ```
  Expected: all payload shape tests pass. The mock client must return a metadata response containing the test objects. Confirm that `toolsCall` is called with the correct `toolName` for `iOSDevices` (expect `find_i_o_s_devices`, NOT `find_iosdevices`) and `companyAnalytics` (expect `find_company_analytics`).

- [ ] **Full unit suite**:
  ```bash
  cd packages/twenty-mcp && npx jest --config jest.config.ts
  ```
  Expected: all tests pass (current baseline: 205; new total ~230 after adding embedded-acronym and mass-noun cases). Zero regressions on existing tests.

- [ ] **Type check**:
  ```bash
  cd packages/twenty-mcp && npx nx typecheck twenty-mcp
  ```
  Expected: 0 errors. The `camelToSnakeCase` import must resolve correctly from `twenty-shared/utils`.

- [ ] **Contract test** (regression check on adjacent tooling):
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/contract.test.ts --config jest.config.ts
  ```
  Expected: 18 tests pass.

- [ ] **SDK boundary test** (tools/list registry check):
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/sdk-boundary.test.ts --config jest.config.ts
  ```
  Expected: passes. The fix does not add or remove any registered tool names.

- [ ] **Integration — embedded acronym CRUD (requires running stack at localhost:4440 / localhost:4441)**:
  ```bash
  cd packages/twenty-mcp
  TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
    npx dotenv -e .env.local -- npx jest \
      --testPathPatterns='round-trip.test.ts' \
      --testNamePattern='embedded-acronym' \
      --config jest.config.ts
  ```
  Expected: `myAPIKeyFixture` object created; `find_my_a_p_i_key_fixtures` routes correctly (success: true); create/get/update/delete succeed; fixture cleaned up in afterAll.

- [ ] **Integration — mass noun CRUD (requires running stack)**:
  ```bash
  cd packages/twenty-mcp
  TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
    npx dotenv -e .env.local -- npx jest \
      --testPathPatterns='round-trip.test.ts' \
      --testNamePattern='mass-noun' \
      --config jest.config.ts
  ```
  Expected: mass-noun fixture object created; `create_<snake_singular>` routes correctly (success: true, NOT "Tool not found"); singular ops use server-stored `nameSingular` directly (no `pluralize` inference).

- [ ] **Integration — full round-trip suite (regression)**:
  ```bash
  cd packages/twenty-mcp
  TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
    npx dotenv -e .env.local -- npx jest \
      --testPathPatterns='round-trip.test.ts' \
      --config jest.config.ts
  ```
  Expected: all tests pass (current baseline: 16; new total ~26 with embedded-acronym + mass-noun blocks). Pre-existing people CRUD, link_note_to_record, and multi-word CRUD (issue #11 block) all still green.

- [ ] **Unrecognised-object error message** (manual):
  ```bash
  curl -sX POST "http://localhost:4441/mcp" \
    -H "Authorization: Bearer $TWENTY_API_KEY" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_records","arguments":{"object":"nonExistentObject","limit":5}}}'
  ```
  Expected: error response containing "not found in workspace" and a list of available object names — NOT a raw "Tool not found" error with no context.

## Failure modes named (R3: adversarial pre-mortem)

1. **Metadata fetch adds latency that makes CRUD wrappers noticeably slow for LLM agents.** A metadata call adds ~5–20 ms per CRUD operation on a local stack; higher on a remote server. For an LLM agent that issues dozens of CRUD calls in a session, this accumulates. Mitigation: the plan acknowledges this is out of scope for caching; the implementer must add a brief inline comment (`// TODO: add in-process TTL cache — see follow-up`) so the latency cost is visible to the next reader. The correctness benefit is not negotiable (both bugs cause 100% failure rate for affected object names). A follow-up plan should introduce a request-scoped or module-level cache with a short TTL (e.g. 30 s).

2. **`resolveObjectNames` matches the wrong object if two objects have the same lowercase-stripped form (e.g. `myAPIKey` and `myApiKey` in the same workspace).** This is an edge case but legal given Twenty's validation regex. Mitigation: the resolution function must prefer exact case-sensitive matches before falling back to case-insensitive; if two objects match after lowercasing, throw a disambiguation error naming both matches and asking the agent to pass the exact `nameSingular` or `namePlural`. The error message IS the safety net — never silently route to the first match.

3. **The metadata fetch itself fails (network error, auth error, or Twenty returns an unexpected envelope shape).** If `metadata_query` throws or returns a non-array, the CRUD wrapper propagates a confusing error. Mitigation: wrap the metadata fetch in a try/catch inside `resolveObjectNames`; on failure, throw a structured error — `"Failed to fetch object metadata for resolving '${input}': ${err.message}. Verify the MCP server can reach Twenty at ${baseUrl}."` This surfaces the real failure cause (network/auth) rather than a "Tool not found" from a downstream inner-tool call on a garbage name.

## Out of scope

- **In-process TTL cache for the metadata fetch.** Deferring: the correctness fix is the priority; caching is an optimisation. Worst-case bug class if deferred indefinitely: none — omitting the cache makes CRUD slower but not wrong. Acceptable. Should be filed as a separate low-priority improvement after this plan closes.

- **Removing `pluralize` from `package.json` entirely.** Deferring: `pluralize` may be used elsewhere or by transitive consumers. The implementer should `grep -r 'pluralize' packages/twenty-mcp/src` after removing the import from `crm.ts` and confirm it is unused before removing the package dependency. If unused, remove it; if still used elsewhere, leave it. Worst-case if not removed: unused dependency remains in the manifest (cosmetic; no bug class).

- **`discovery` tool description update.** The `discovery` tool's `objectArg` description currently says "Either singular ('person') or plural ('people') — both forms route correctly." After this fix, routing correctness comes from the metadata fetch, not from pluralize inference — the description is still accurate. No update needed.

- **Handling workspace-scoped object names that are not accessible to the current API key (permission-gated objects).** The metadata fetch returns only objects visible to the workspace; objects the API key can't access won't appear in the list. Resolution failure for a permission-gated object name will surface the "not found in workspace" error. This is correct behaviour (the agent shouldn't be able to call CRUD on objects it can't read). Out of scope.

## References

- `packages/twenty-mcp/CLAUDE.md` — architecture invariants (L1: capture don't transcribe; R4: every assertion has a mechanical verifier)
- `packages/twenty-mcp/plans/issue-11-inner-tool-name-camelcase-boundary.md` — prior plan (the regex fix that this plan supersedes for the two residual gap classes)
- `packages/twenty-mcp/plans/issue-11-inner-tool-name-camelcase-boundary-audit-round-1.md` — audit round 1 that filed issues #12 and #13
- `packages/twenty-mcp/src/tools/crm.ts:29–46` — `normalize()`, the function being replaced
- `packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts:1` — canonical `camelToSnakeCase` algorithm
- `packages/twenty-server/src/engine/core-modules/tool-provider/providers/database-tool.provider.ts:117–118` — server-side tool name construction using `camelToSnakeCase(objectMetadata.nameSingular)` / `camelToSnakeCase(objectMetadata.namePlural)`
- `packages/twenty-mcp/src/__tests__/crm.test.ts` — existing unit tests including "documents pluralize-mass-noun limitation"
- `packages/twenty-mcp/src/__tests__/crm-coverage.test.ts` — existing drift gate (to be repurposed)
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` — integration suite to extend

## Implementation notes
> Implemented: 2026-05-12T00:00:00Z

### Files changed
```
packages/twenty-mcp/package.json
packages/twenty-mcp/src/__tests__/contract.test.ts
packages/twenty-mcp/src/__tests__/crm-coverage.test.ts
packages/twenty-mcp/src/__tests__/crm.test.ts
packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts
packages/twenty-mcp/src/tools/crm.ts
yarn.lock
```

### Diff stat
```
 packages/twenty-mcp/package.json                   |   1 +
 packages/twenty-mcp/src/__tests__/contract.test.ts |  19 ++
 packages/twenty-mcp/src/__tests__/crm-coverage.test.ts  | 338 ++++++++++++++++-----
 packages/twenty-mcp/src/__tests__/crm.test.ts      | 292 ++++++++++++++----
 packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json |  37 ++-
 packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts   | 287 ++++++++++++++++-
 packages/twenty-mcp/src/tools/crm.ts               | 190 +++++++++---
 yarn.lock                                          |   4 +
 8 files changed, ~1164 insertions(+), ~201 deletions(-)
```

### Test results

**Test plan item 1 — Dependency check**: PASS
```
packages/twenty-mcp/package.json contains: "twenty-shared": "workspace:*"
```
Note: yarn.lock updated. `yarn install` exited non-zero due to Node v22 post-install validation (env requires v24.5), but the workspace symlink for `twenty-shared` was already resolved. The `workspace:*` protocol is correct for Yarn 4.

**Test plan item 2 — Unit: name construction (crm.test.ts)**: PASS
```
PASS src/__tests__/crm.test.ts
Tests: 29 passed, 29 total
```

**Test plan item 3 — Unit: resolution logic (crm-coverage.test.ts)**: PASS
```
PASS src/__tests__/crm-coverage.test.ts
Tests: 25 passed, 25 total
```

**Test plan item 4 — Unit: wire-level payload assertions**: PASS
```
PASS src/__tests__/crm.test.ts
Tests: 16 skipped, 13 passed, 29 total (pattern: 'CRM convenience tools')
```

**Test plan item 5 — Full unit suite**: PASS
```
Test Suites: 16 passed, 16 total
Tests: 212 passed, 212 total
```

**Test plan item 6 — Type check**: PASS
```
npx tsc --noEmit
NX Successfully ran target typecheck for project twenty-mcp
```

**Test plan item 7 — Contract test**: PASS
```
PASS src/__tests__/contract.test.ts
Tests: 18 passed, 18 total
```

**Test plan item 8 — SDK boundary test**: PASS
```
PASS src/__tests__/sdk-boundary.test.ts
Tests: 2 passed, 2 total
```

**Test plan item 9 — Integration: embedded-acronym CRUD**: PASS
```
PASS src/__tests__/integration/round-trip.test.ts
Tests: 21 skipped, 6 passed, 27 total
  ✓ search_records routes to find_my_a_p_i_key_fixtures (NOT find_myapikeyfixtures)
  ✓ create_record routes to create_my_a_p_i_key_fixture
  ✓ get_record routes to find_one_my_a_p_i_key_fixture
  ✓ update_record routes to update_my_a_p_i_key_fixture
  ✓ delete_record routes to delete_my_a_p_i_key_fixture
  ✓ singular-form input routes to find_my_a_p_i_key_fixtures
```

**Test plan item 10 — Integration: mass-noun CRUD**: PASS
```
PASS src/__tests__/integration/round-trip.test.ts
Tests: 22 skipped, 5 passed, 27 total
  ✓ search_records routes to find_company_analytics_fixtures (NOT find_company_analytic_fixtures)
  ✓ create_record routes to create_company_analytics_fixture (NOT create_company_analytic_fixture)
  ✓ get_record routes to find_one_company_analytics_fixture
  ✓ update_record routes to update_company_analytics_fixture
  ✓ delete_record routes to delete_company_analytics_fixture
```

**Test plan item 11 — Integration: full round-trip suite**: PASS
```
PASS src/__tests__/integration/round-trip.test.ts
Tests: 27 passed, 27 total
  All pre-existing blocks (people CRUD, link_note_to_record, operand validation, #11 multi-word) still green.
  New blocks (#12 embedded-acronym, #13 mass-noun) all green.
```

**Test plan item 12 — Manual: unrecognised-object error message**: NOT RUN AGAINST LIVE PROXY
The live proxy at localhost:4441 is running `twenty-mcp:local` Docker image (pre-built). It was not rebuilt during this session (docker build/restart is forbidden per system prompt). The curl test against the running container returned the OLD "Tool not found" error. The fix is verified end-to-end via the integration tests (items 9-11) which run the source code directly. The live proxy would need to be rebuilt (`docker compose build mcp && docker compose up -d mcp`) to verify this item.

### Surprises

1. **`metadata_query` is a proxy-level tool, not an inner tool**: The plan spec says `resolveObjectNames` should call `client.toolsCall('metadata_query', {kind: 'objects'})`. This does NOT work because `TwentyMcpClient.toolsCall()` routes to Twenty's `/mcp` endpoint, and `metadata_query` is a tool registered on the proxy's own MCP server — not on Twenty's `/mcp`. The actual inner tool to call is `execute_tool({toolName: 'get_object_metadata', arguments: {}})`. The integration tests confirmed this is the correct approach.

2. **`twenty-shared` has no compiled `dist/`**: The plan says `import { camelToSnakeCase } from 'twenty-shared/utils'`. Since `twenty-shared` has no `dist/` folder and `moduleResolution: node` requires compiled output for the `./utils` export, this import path would fail at type-check. Solution: `camelToSnakeCase` is defined locally in `crm.ts` as a one-line function (identical algorithm to `twenty-shared`). The `twenty-shared: "workspace:*"` dep was added to `package.json` per the plan (correct workspace protocol for Yarn 4). A follow-up should replace the local definition with the import once `twenty-shared` is built.

3. **`yarn install` post-install validation fails on Node v22**: The repo's `yarn.config.cjs` enforces Node v24.5, but the runtime is v22.16. The install exit code was non-zero for this reason, but the dependency resolution itself succeeded (workspace symlink was already in place). No impact on compilation or tests.

4. **Ambiguity test needed different fixture objects**: The plan's ambiguity test used `{myAPIKey, myApiKey}` expecting `my_api_key` to match both. `camelToSnakeCase('myAPIKey')` → `my_a_p_i_key` and `camelToSnakeCase('myApiKey')` → `my_api_key` — only one match, no ambiguity. The test was rewritten to use `{testObject, testobject}` where `testobject.toLowerCase()` matches both.

5. **`coverage.test.ts` scans `crm.ts` for `toolName: '<X>'` literals**: The new `get_object_metadata` call in `resolveObjectNames` was caught by the coverage test's inner-tool name scanner. Added `get_object_metadata` to `inner-tool-schemas.json` fixture with a minimal schema entry.

6. **`contract.test.ts` needed the metadata mock**: The `makeCapturingClient` stub in `contract.test.ts` returned `'ok'` for all `toolsCall` calls. The new async resolve path calls `execute_tool({toolName:'get_object_metadata'})` first, and `'ok'` is not valid JSON — causing `resolveObjectNames` to throw. Added a `get_object_metadata` branch to `makeCapturingClient` returning the fixture metadata list.

7. **Test plan item count**: The plan lists 10 items in `## Test plan` but actually has 12 items when counted individually (dependency check + 2 unit items + 1 wire-level + 1 full suite + type check + contract + sdk-boundary + 2 integration + 1 full integration + 1 manual). All items run or noted as requiring infra rebuild.

> Audit round 1: clean-with-mediums — see issue-12-crm-wrapper-name-inference-replace-with-server-metadata-audit-round-1.md
> Audit round 1: medium defects → filed issue #15 (get_object_metadata fixture L1 violation)
> Audit round 1: LOW absorbed pre-commit (trivial-in-place): removed misleading "case-sensitive match first" sentence from resolveObjectNames doc-comment
> Audit round 1: LOW backlogged (cosmetic): surprise #4 reasoning misdiagnoses matching algorithm
> Audit round 1: LOW backlogged (foot-gun): localhost:4441 proxy container is stale until docker compose build mcp runs
> Audit round 1: LOW backlogged (foot-gun): local camelToSnakeCase copy could drift silently from twenty-shared
