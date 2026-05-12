# Plan: fix innerToolName camelCase boundary loss (issue #11)

## Context

Issue #11 reports a production bug in `packages/twenty-mcp/src/tools/crm.ts`: the wrapper's `normalize()` function lowercases an object name BEFORE pluralizing, which destroys camelCase word boundaries. As a result, multi-word custom objects (e.g. `schemaChangeAudit`) get mapped to `find_schemachangeaudits` (no internal underscores), but Twenty server registers them as `find_schema_change_audits` (via `camelToSnakeCase`). All five CRUD wrappers — `search_records`, `get_record`, `create_record`, `update_record`, `delete_record` — fail with "Tool not found" for any multi-word custom object.

**Blast radius**: every multi-word custom object on every Twenty workspace. Currently invisible because all standard Twenty objects use single-word `nameSingular` (`company`, `person`, `note`, `task`, `opportunity`) — so the bug is silent until a project creates a multi-word custom object. Discovered while bootstrapping the `tech-philosophy-agents` project's `crm-administration` agent pod, which writes rows to a `schemaChangeAudit` audit-trail object.

**Bug class**: textbook L1 violation per `packages/twenty-mcp/CLAUDE.md` ("Schemas live in the wrapped system, not the wrapper. Capture; don't transcribe."). Two algorithms transcribed independently — they happen to agree on the happy path (single-word names) so the divergence went unnoticed until a multi-word case surfaced. Same class as issue #3's hand-transcribed `FIELD_TYPE_OPERAND_MAP`.

## Investigation summary (Phase 1 findings)

**Bug location confirmed** at [packages/twenty-mcp/src/tools/crm.ts:29-36](packages/twenty-mcp/src/tools/crm.ts#L29-L36):

```typescript
const normalize = (object: string): { singular: string; plural: string } => {
  const trimmed = object.trim().replace(/\s+/g, '_').toLowerCase();  // ← .toLowerCase() before pluralize destroys camelCase boundaries
  return {
    singular: pluralize.singular(trimmed),
    plural: pluralize.plural(trimmed),
  };
};
```

`innerToolName()` at [crm.ts:38-55](packages/twenty-mcp/src/tools/crm.ts#L38-L55) consumes `normalize()` for all 5 CRUD ops; consumed at [crm.ts:140,146,148,150,155](packages/twenty-mcp/src/tools/crm.ts#L140) (one per operation).

**Server-side ground truth** at [packages/twenty-server/src/engine/core-modules/tool-provider/providers/database-tool.provider.ts:40-41](packages/twenty-server/src/engine/core-modules/tool-provider/providers/database-tool.provider.ts#L40-L41): `camelToSnakeCase(objectMetadata.nameSingular)` + `camelToSnakeCase(objectMetadata.namePlural)`. The `camelToSnakeCase` helper at [packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts](packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts) is `str.replace(/[A-Z]/g, (l) => '_' + l.toLowerCase())`.

**Existing tests** at [packages/twenty-mcp/src/__tests__/crm.test.ts:10-35](packages/twenty-mcp/src/__tests__/crm.test.ts#L10-L35) cover `person`, `people`, `company`, `companies`, `opportunity`, `blocklist`, and `'Note Targets'` (space-separated) — all single-word object stems. **Zero coverage of camelCase multi-word names** — the bug went unnoticed because the test suite never exercised the failure mode.

**No sibling bug instances found** in twenty-mcp (Phase 1 sweep):
- `discovery.ts:155-159` — uses `toLowerCase()` only for case-insensitive filtering, not for identifier computation. Safe.
- `metadata.ts`, `workflows.ts`, `access.ts`, `note-targets.ts`, `views.ts` — all inner-tool/mutation names are hardcoded literals (not computed from user input). Safe.
- `views.ts` already has `FILTER_OPERANDS_MAP` synced via a CI verifier (from issue #3). Covered.

**Pluralize behaviour confirmed**: `pluralize.plural('schema_change_audit')` → `'schema_change_audits'`, `pluralize.singular('schema_change_audits')` → `'schema_change_audit'`. The library respects existing underscores; the bug is purely in the pre-pluralize transform.

## Approach

Apply the issue reporter's targeted regex fix to `normalize()`: insert underscores at camelCase boundaries BEFORE lowercasing. This makes the wrapper's algorithm produce the same output as the server's `camelToSnakeCase` for any input the server itself would emit (camelCase names from `objectMetadata.nameSingular`/`namePlural`), AND additionally handles agent-friendly inputs the wrapper already advertised (`'Note Targets'`, `'Company'`, already-snake_cased forms) without breaking them.

### Why regex, not `camelToSnakeCase` import

A naive "import `camelToSnakeCase` from `twenty-shared`" doesn't work as a drop-in:
- `twenty-mcp/package.json` does not currently depend on `twenty-shared` — adding it is a structural change with broader implications than this fix.
- `camelToSnakeCase('Company')` → `'_company'` (leading underscore needs stripping); `camelToSnakeCase('Note Targets')` → `'note _targets'` (space preservation breaks). The wrapper's advertised contract accepts both forms; preserving that requires pre/post processing around `camelToSnakeCase` anyway.
- The regex `([a-z0-9])([A-Z])` does the same job with no new dependency and handles all the edge cases naturally.

If we later want to "capture, don't transcribe" more strictly (L1), a follow-up plan can refactor to import `camelToSnakeCase` plus the preprocessing. For this fix, the regex is the minimum-blast-radius correct path.

### Code change

[packages/twenty-mcp/src/tools/crm.ts:29-36](packages/twenty-mcp/src/tools/crm.ts#L29-L36) — replace `normalize()`:

```typescript
const normalize = (object: string): { singular: string; plural: string } => {
  // Insert underscores at camelCase boundaries BEFORE lowercasing, so
  // multi-word custom objects (`schemaChangeAudits` → `schema_change_audits`)
  // match Twenty server's tool names (registered via camelToSnakeCase in
  // packages/twenty-server/.../database-tool.provider.ts). Without this,
  // toLowerCase strips word boundaries and pluralize is a no-op, producing
  // `find_schemachangeaudits` instead of `find_schema_change_audits`.
  // See issue #11 for the full failure mode.
  const snakeified = object
    .trim()
    .replace(/\s+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return {
    singular: pluralize.singular(snakeified),
    plural: pluralize.plural(snakeified),
  };
};
```

### Test additions — two pieces

**Piece 1**: [packages/twenty-mcp/src/__tests__/crm.test.ts:10-35](packages/twenty-mcp/src/__tests__/crm.test.ts) — extend the existing `innerToolName` test block with multi-word coverage (pins agreed-on outputs):

```typescript
// Multi-word custom objects (camelCase) — issue #11
expect(innerToolName('search', 'schemaChangeAudits')).toBe('find_schema_change_audits');
expect(innerToolName('search', 'schemaChangeAudit')).toBe('find_schema_change_audits');
expect(innerToolName('get', 'schemaChangeAudit')).toBe('find_one_schema_change_audit');
expect(innerToolName('create', 'customerHealth')).toBe('create_customer_health');
expect(innerToolName('update', 'companyAnalytics')).toBe('update_company_analytics');
expect(innerToolName('delete', 'salesActivity')).toBe('delete_sales_activity');

// Already-snake_cased forms (existing workaround) still work
expect(innerToolName('search', 'schema_change_audits')).toBe('find_schema_change_audits');
expect(innerToolName('search', 'schema_change_audit')).toBe('find_schema_change_audits');

// Edge cases: PascalCase, space-separated (the wrapper's advertised flexibility)
expect(innerToolName('search', 'SchemaChangeAudits')).toBe('find_schema_change_audits');
expect(innerToolName('search', 'Schema Change Audits')).toBe('find_schema_change_audits');
```

Single-word existing tests stay green (verified by tracing: `'person'` → `'person'` → `'people'` unchanged; `'Note Targets'` → `'Note_Targets'` → `'note_targets'` unchanged).

**Piece 2** (NEW — CI drift verifier): create [packages/twenty-mcp/src/__tests__/crm-coverage.test.ts](packages/twenty-mcp/src/__tests__/crm-coverage.test.ts). Pattern mirrors the existing `views-coverage.test.ts` (from issue #3) — reads the canonical source from `twenty-shared` at test time and asserts the wrapper's algorithm matches server's `camelToSnakeCase` for a curated camelCase input list. This catches future drift if either side's algorithm changes.

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pluralize from 'pluralize';

import { innerToolName } from '../tools/crm';

const CAMEL_TO_SNAKE_SOURCE_PATH = join(
  __dirname,
  '../../../twenty-shared/src/utils/strings/camelToSnakeCase.ts',
);

/**
 * Loads the canonical camelToSnakeCase from twenty-shared. Validates the
 * source file still exists AND its signature matches what we expect — if it
 * doesn't (e.g. the algorithm was changed server-side), this throws loudly so
 * the wrapper's regex can be updated in lockstep.
 *
 * Returns a runtime function implementing the canonical algorithm.
 */
const loadCanonicalCamelToSnakeCase = (): ((s: string) => string) => {
  if (!existsSync(CAMEL_TO_SNAKE_SOURCE_PATH)) {
    throw new Error(
      `twenty-shared camelToSnakeCase source not found at ${CAMEL_TO_SNAKE_SOURCE_PATH} ` +
        `— file moved or renamed. Update CAMEL_TO_SNAKE_SOURCE_PATH in crm-coverage.test.ts.`,
    );
  }
  const source = readFileSync(CAMEL_TO_SNAKE_SOURCE_PATH, 'utf8');
  // Assert the source still implements the regex-replace algorithm. If this fails,
  // the wrapper's normalize() must be re-evaluated against the new algorithm.
  const expectedSignature =
    /replace\(\s*\/\[A-Z\]\/g\s*,\s*\(letter\)\s*=>\s*`_\$\{letter\.toLowerCase\(\)\}`\s*\)/;
  if (!expectedSignature.test(source)) {
    throw new Error(
      `twenty-shared camelToSnakeCase no longer implements the expected regex-replace pattern. ` +
        `Audit packages/twenty-mcp/src/tools/crm.ts:normalize() against the new algorithm and ` +
        `update the expectedSignature regex in crm-coverage.test.ts.\n\nCurrent source:\n${source}`,
    );
  }
  // The signature check above is the drift gate. The returned function is a
  // local mirror of the canonical algorithm — both are validated to agree.
  return (s: string) => s.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
};

describe('crm-coverage: wrapper normalize() matches server camelToSnakeCase for camelCase inputs', () => {
  const camelToSnakeCase = loadCanonicalCamelToSnakeCase();

  // Inputs Twenty server would actually emit as nameSingular / namePlural —
  // i.e. camelCase, lowercase-first. Curated to cover 1-, 2-, and 3-word stems.
  const CAMEL_CASE_INPUTS: ReadonlyArray<{ singular: string; plural: string }> = [
    { singular: 'person', plural: 'people' },
    { singular: 'company', plural: 'companies' },
    { singular: 'opportunity', plural: 'opportunities' },
    { singular: 'schemaChangeAudit', plural: 'schemaChangeAudits' },
    { singular: 'customerHealth', plural: 'customerHealths' },
    { singular: 'companyAnalytics', plural: 'companyAnalytics' },
    { singular: 'salesActivity', plural: 'salesActivities' },
    { singular: 'productCategory', plural: 'productCategories' },
    { singular: 'noteTarget', plural: 'noteTargets' },
    { singular: 'workflowVersion', plural: 'workflowVersions' },
  ];

  // Build canonical server-side tool names per the database-tool.provider.ts logic:
  //   find_${camelToSnakeCase(namePlural)}
  //   find_one_${camelToSnakeCase(nameSingular)}
  //   create_${camelToSnakeCase(nameSingular)} (and update / delete)
  for (const { singular, plural } of CAMEL_CASE_INPUTS) {
    const canonicalPlural = camelToSnakeCase(plural);
    const canonicalSingular = camelToSnakeCase(singular);

    it(`'${singular}' (singular) → find_one matches server camelToSnakeCase`, () => {
      expect(innerToolName('get', singular)).toBe(`find_one_${canonicalSingular}`);
    });
    it(`'${plural}' (plural) → find matches server camelToSnakeCase`, () => {
      expect(innerToolName('search', plural)).toBe(`find_${canonicalPlural}`);
    });
    it(`'${singular}' → create matches server camelToSnakeCase`, () => {
      expect(innerToolName('create', singular)).toBe(`create_${canonicalSingular}`);
    });
  }
});
```

The signature-regex gate is the mechanical drift detector: if `twenty-shared/utils/strings/camelToSnakeCase.ts` is ever rewritten (e.g. to handle consecutive capitals differently, or moved to a different module), this test fails loudly with a clear "audit normalize() against the new algorithm" message, preventing silent re-divergence.

A note about robustness: the test uses `existsSync` to surface a clean "file moved" error rather than a stack trace on `readFileSync`. If `twenty-shared` is restructured, the failure message points directly at the constant to update.

## Critical files

**Modify:**
- [packages/twenty-mcp/src/tools/crm.ts](packages/twenty-mcp/src/tools/crm.ts) — `normalize()` at lines 29-36 (only)
- [packages/twenty-mcp/src/__tests__/crm.test.ts](packages/twenty-mcp/src/__tests__/crm.test.ts) — extend `innerToolName` test block (~10 new assertions)

**Create:**
- [packages/twenty-mcp/src/__tests__/crm-coverage.test.ts](packages/twenty-mcp/src/__tests__/crm-coverage.test.ts) — NEW. Reads `twenty-shared` source at test time, asserts wrapper's `normalize()` agrees with canonical `camelToSnakeCase` for curated camelCase inputs. Signature-regex drift gate. Mirrors the existing `views-coverage.test.ts` pattern.

**Reference (do not modify, read at test time):**
- [packages/twenty-server/src/engine/core-modules/tool-provider/providers/database-tool.provider.ts:40-41](packages/twenty-server/src/engine/core-modules/tool-provider/providers/database-tool.provider.ts#L40) — server-side `camelToSnakeCase` usage; the canonical algorithm the wrapper must match
- [packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts](packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts) — the canonical helper (read by `crm-coverage.test.ts` at test time)

## Test plan (R4: every assertion has a mechanical verifier)

**ALL TESTS MUST RUN AGAINST THE LOCAL DOCKER STACK.** The stack is brought up via `bash packages/twenty-utils/setup-dev-env.sh` (which uses `docker-compose.deploy.yml` per the recent setup-script change; runs db + redis + server + worker + mcp on localhost-only ports, skipping caddy). The same workspace + API key from the prior session is reused (volumes preserved across `down`/`up`).

**Idempotency rules — apply before any stack action:**

1. **Check stack-up by ENDPOINT, not by container name.** Container names vary depending on docker compose project name (the deploy compose defaults to `twenty-deploy-*`, but a user may have started the stack with `-p twenty-local` or via a different compose file, producing `twenty-local-*`). The reliable signal is whether the SERVICE is reachable:
   ```bash
   curl -sf http://localhost:4440/healthz >/dev/null && \
   curl -sf -X POST http://localhost:4441/mcp \
     -H "Authorization: Bearer $(grep '^TWENTY_API_KEY=' packages/twenty-mcp/.env.local | cut -d= -f2-)" \
     -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
     >/dev/null && echo "stack ready" || echo "stack not reachable"
   ```
   If both succeed, the stack is up — DO NOT run `setup-dev-env.sh`. If either fails, the supervisor (NOT the agent) decides whether to bring it up.
2. **`setup-dev-env.sh` is itself idempotent.** Its `docker compose up -d <services>` invocation is a no-op for already-running healthy containers — it neither restarts them nor recreates them. But running it unnecessarily wastes ~5-10 seconds on healthcheck polling and clutters output. Skip the call when the endpoints are reachable.
3. **NEVER `docker compose down` then `up` mid-cycle.** That would wipe in-memory state on Twenty server (sessions, caches) and possibly disrupt the in-flight test. If the running stack is in a broken state, the supervisor (NOT the agent) decides whether to restart it.
4. **The agent NEVER spins up containers.** Per the hardened agent prompt (`.claude/agents/issue-implementer.md`), the implementer is forbidden from running `docker compose up` autonomously. If the endpoints are not reachable, the implementer HALTs with `## Implementation notes — blocked: local stack not reachable at localhost:4440 / localhost:4441, supervisor must provision`. The supervisor brings up the stack first via `setup-dev-env.sh` (idempotent), then re-invokes `/implement-issue-fix`.

### Unit-level mechanical verifiers (in-process, no live calls)

- [ ] `cd packages/twenty-mcp && npx jest src/__tests__/crm.test.ts --config jest.config.ts` — expect: existing tests pass + ~10 new multi-word `innerToolName` assertions pass.
- [ ] `cd packages/twenty-mcp && npx jest src/__tests__/crm-coverage.test.ts --config jest.config.ts` — NEW. Expect: ~30 assertions pass (3 ops × 10 camelCase inputs), all confirming wrapper matches canonical `camelToSnakeCase`. Run on default invocation (NOT integration-gated — same lesson learned from issue #7 round 2).
- [ ] **Drift-gate regression check**: temporarily modify `packages/twenty-shared/src/utils/strings/camelToSnakeCase.ts` (e.g. add a no-op space at the start of the function body) and re-run `crm-coverage.test.ts` — expect the signature-regex assertion to fail with a clear "no longer implements the expected pattern" error. Restore before committing.
- [ ] `cd packages/twenty-mcp && npx jest --config jest.config.ts` — full unit suite green. Currently 171 tests; new total ~211 (10 new in crm.test.ts + ~30 in crm-coverage.test.ts).
- [ ] `cd packages/twenty-mcp && npx jest src/__tests__/contract.test.ts --config jest.config.ts` — 18 tests pass (regression check on adjacent tooling).
- [ ] `cd packages/twenty-mcp && npx nx typecheck twenty-mcp` — 0 errors.

### Integration verifier against the local docker stack (REQUIRED — no defer)

- [ ] **Pre-condition check (endpoint-based, not container-name-based)**: `curl -sf http://localhost:4440/healthz` returns 200 AND a `tools/call initialize` request to `http://localhost:4441/mcp` with `Authorization: Bearer <TWENTY_API_KEY>` returns 200. If either fails, the implementer must HALT with `## Implementation notes — blocked: local Twenty stack not reachable at localhost:4440/4441`, per the hardened agent prompt's "never bring up infra autonomously" rule. The supervisor brings up the stack first. Do NOT match against container names like `twenty-deploy-*` or `twenty-local-*` — the project name varies depending on which compose configuration the user runs.

- [ ] **New integration test** at [packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts](packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts) — add a new `describeIfDestructive` block: `integration: multi-word custom object CRUD (issue #11)`. The test self-creates a custom object fixture, runs CRUD against it, and cleans up. This is the end-to-end mechanical verifier proving the fix works against the actual Twenty server, not just against the wrapper's local algorithm.

  ```typescript
  describeIfDestructive('integration: multi-word custom object CRUD (issue #11)', () => {
    const objNameSingular = 'mcpAuditFixture';  // 2-word camelCase — provably exercises the bug
    const objNamePlural = 'mcpAuditFixtures';
    let objectMetadataId: string | undefined;
    let createdRecordId: string | undefined;

    const metadata = buildMetadataHandlers(client, apiKey);
    const crm = buildCrmHandlers(client);

    beforeAll(async () => {
      // Defensive cleanup: if a prior test run crashed before afterAll, the
      // mcpAuditFixture object may still exist on the workspace. Query first,
      // delete if found, then create fresh. This keeps the test idempotent
      // across re-runs without requiring a manual `docker compose down -v`.
      const existing = await metadata.metadataQuery({
        kind: 'objects',
        args: { limit: 200 },
      });
      const existingText = (existing.content[0] as { type: 'text'; text: string }).text;
      const existingObjects = parseInnerOrGraphqlArray<{ id: string; nameSingular: string }>(
        existingText,
      );
      const stale = existingObjects.find((o) => o.nameSingular === objNameSingular);
      if (stale) {
        await metadata.metadataApplyPlan({
          mutations: [
            {
              key: 'cleanup_stale_fixture',
              op: 'DELETE_OBJECT',
              args: { id: stale.id },
            },
          ],
        });
      }

      // Bootstrap the test fixture: create a 2-word custom object via apply_plan.
      const result = await metadata.metadataApplyPlan({
        mutations: [
          {
            key: 'create_mcp_audit_fixture',
            op: 'CREATE_OBJECT',
            args: {
              nameSingular: objNameSingular,
              namePlural: objNamePlural,
              labelSingular: 'MCP Audit Fixture',
              labelPlural: 'MCP Audit Fixtures',
              icon: 'IconTestPipe',
              description: 'Temporary fixture for issue #11 integration test. Safe to delete.',
            },
          },
        ],
      });
      const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      if (parsed.failed) {
        throw new Error(
          `round-trip.test: failed to bootstrap mcpAuditFixture object: ${JSON.stringify(parsed.failed)}. ` +
            `If a stale fixture exists despite the defensive cleanup above, investigate manually via ` +
            `metadata_query({kind:'objects'}) and delete via DELETE_OBJECT.`,
        );
      }
      objectMetadataId = parsed.applied?.[0]?.result?.id;
      if (!objectMetadataId) {
        throw new Error('round-trip.test: CREATE_OBJECT succeeded but no objectMetadataId returned.');
      }
    });

    afterAll(async () => {
      // Cleanup: delete the fixture object so the workspace returns to its pre-test state.
      if (objectMetadataId) {
        await metadata.metadataApplyPlan({
          mutations: [
            {
              key: 'delete_mcp_audit_fixture',
              op: 'DELETE_OBJECT',
              args: { id: objectMetadataId },
            },
          ],
        });
      }
    });

    it('search_records on multi-word object name routes to find_mcp_audit_fixtures (NOT find_mcpauditfixtures)', async () => {
      const result = await crm.searchRecords({ object: objNamePlural, limit: 5 });
      const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.success).toBe(true);
      // Before-fix failure mode: "Tool \"find_mcpauditfixtures\" not found"
      // After-fix: success with an empty result set on a fresh object.
    });

    it('create_record on multi-word object name routes to create_mcp_audit_fixture', async () => {
      // Twenty auto-creates a `name` field on every custom object; we write to that.
      const result = await crm.createRecord({
        object: objNameSingular,
        data: { name: 'issue-11-test-row' },
      });
      const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.success).toBe(true);
      expect(parsed.result?.id).toBeTruthy();
      createdRecordId = parsed.result.id as string;
    });

    it('get_record on multi-word object name routes to find_one_mcp_audit_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set — create test must precede');
      const result = await crm.getRecord({ object: objNameSingular, id: createdRecordId });
      const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.success).toBe(true);
      const record = (parsed.result as { records?: Array<{ id: string }> })?.records?.[0];
      expect(record?.id).toBe(createdRecordId);
    });

    it('update_record on multi-word object name routes to update_mcp_audit_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.updateRecord({
        object: objNameSingular,
        id: createdRecordId,
        data: { name: 'issue-11-test-row-updated' },
      });
      const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.success).toBe(true);
    });

    it('delete_record on multi-word object name routes to delete_mcp_audit_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.deleteRecord({ object: objNameSingular, id: createdRecordId });
      const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.success).toBe(true);
    });

    it('also routes for singular-form input → search converts to plural correctly', async () => {
      const result = await crm.searchRecords({ object: objNameSingular, limit: 5 });
      const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(parsed.success).toBe(true);  // wrapper pluralizes 'mcpAuditFixture' → find_mcp_audit_fixtures
    });
  });
  ```

- [ ] Run the integration suite:
  ```bash
  cd packages/twenty-mcp
  TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
    npx dotenv -e .env.local -- npx jest --testPathPatterns='round-trip.test.ts' --config jest.config.ts
  ```
  Expected: 16 tests pass (10 pre-existing + 6 new from this issue's block — search, create, get, update, delete, singular-form). The 6 new tests collectively prove the wrapper's name transformation routes correctly to the server's `camelToSnakeCase`-registered tools.

- [ ] **Cleanup verification**: after the integration suite runs, query the workspace to confirm the fixture object was deleted (the `afterAll` should handle this, but verify):
  ```bash
  # Via the running MCP, list objects and assert mcpAuditFixture is absent:
  curl -sX POST "http://localhost:4441/mcp" -H "Authorization: Bearer $TWENTY_API_KEY" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"metadata_query","arguments":{"kind":"objects"}}}' \
    | jq '.result.content[0].text | fromjson | .[] | select(.nameSingular == "mcpAuditFixture")'
  # Expected: empty output (object deleted).
  ```

- [ ] **Pre-fix repro verification (one-shot, optional but recommended)**: BEFORE applying the regex fix, run the integration suite and confirm the new `search_records` test fails with the expected error message (`Tool "find_mcpauditfixtures" not found`). This proves the test is non-vacuous — it catches the actual bug. THEN apply the fix and re-run; confirm all 6 new tests pass.

## Failure modes named (R3: adversarial pre-mortem)

1. **The regex `([a-z0-9])([A-Z])` misses a boundary case the server's `camelToSnakeCase` handles differently.** Server's `camelToSnakeCase` inserts `_` before EACH capital. For `'ABCFoo'` (consecutive capitals), server produces `'_a_b_c_foo'`, wrapper's regex produces `'abcfoo'` (no lowercase→capital boundary to match in `'ABC'`). Mitigation: Twenty's auto-generated `nameSingular`/`namePlural` from `createOneObject` enforces camelCase-with-lowercase-first; consecutive-capital object names are not producible via the standard Twenty UI/API. If a workspace somehow has one, the bug recurs for that specific name. Acceptable trade-off; flagged in plan annotation. The 10 new test cases cover all realistic camelCase patterns.

2. **A future fix to `camelToSnakeCase` in `twenty-shared` introduces behaviour the wrapper's regex doesn't match.** Mitigated by `crm-coverage.test.ts` (new in this plan): the signature-regex drift gate fails loudly if the canonical algorithm's source pattern changes, AND ~30 cross-algorithm equivalence assertions catch silent output divergence for the curated input list. If the canonical algorithm is rewritten in a way that still matches the signature regex (e.g. an equivalent rewrite) but diverges in output, the equivalence assertions catch it. The remaining gap: a new camelCase input pattern outside the curated list could still diverge silently — covered as failure-mode #4 below.

3. **An agent passes an object name with leading/trailing whitespace AND camelCase boundaries** (`'  schemaChangeAudits  '`). The current code does `.trim()` first, then space-to-underscore, then camelCase insertion. After `.trim()`, the leading/trailing whitespace is gone; then camelCase insertion handles internal boundaries. Outcome: same as no-whitespace input. Covered.

4. **A new camelCase pattern outside the curated `CAMEL_CASE_INPUTS` list silently diverges between wrapper and server.** The drift gate (signature regex) catches algorithm rewrites but not silent output divergence on uncovered inputs. Mitigation: the curated list covers 1-, 2-, and 3-word camelCase stems with single lowercase→capital boundaries — the realistic pattern Twenty produces via `createOneObject`. The known edge case (consecutive capitals, e.g. `'ABCFoo'`) is documented in failure-mode #1 as out-of-scope because Twenty's UI doesn't surface a path to create such names. If a future workspace somehow has one, the bug recurs for that specific name only. To close completely, the curated list would need every camelCase pattern Twenty supports — acceptable trade-off for now.

## Out of scope

- **Import `camelToSnakeCase` from `twenty-shared` as the canonical source.** Requires adding `twenty-shared` to `twenty-mcp/package.json`. Pure L1 "capture, don't transcribe" but more structural change than the bug warrants. The drift-gate verifier added in this plan catches the same failure mode without requiring the structural change. Filed as a foot-gun backlog candidate IF the verifier ever turns out to be insufficient. Worst case if deferred: the wrapper's regex and twenty-shared's algorithm could in principle drift in a way that the verifier's curated input list doesn't catch — failure-mode #4 documents this gap.
- **Other places in twenty-mcp that compute identifiers.** The Phase 1 sweep ruled them out (Discovery's `toLowerCase` is for filtering only; all other handlers use hardcoded inner-tool names). If a future tool family is added that computes a name from user input, the same audit would re-flag it.
- **Testing with consecutive-capital object names** (e.g. `'ABCFoo'`). Documented as failure-mode #1 — Twenty's `createOneObject` API does not surface a path to create such names from the standard UI, so the bug is latent for an unreachable input class.
- **`pluralize`-mass-noun bug class** (SURFACED MID-IMPLEMENTATION — supervisor revision): for object names containing English mass nouns (`analytics`, `data`, `metadata`, `news`, `series`, `mathematics`, `physics`, `statistics`, etc.), the wrapper's pluralize-based singular/plural round-trip is incorrect REGARDLESS of issue #11's regex fix. Example: `'companyAnalytics'` → snakeified `'company_analytics'` → `pluralize.singular('company_analytics')` = `'company_analytic'` (server registers `_analytics`). The `'search'` op happens to produce the correct name (pluralize.plural is a no-op on already-plural forms), but `'get'/'create'/'update'/'delete'` produce the wrong name. **Worst case if deferred**: same bug class as #11 (CRUD wrappers fail with "Tool not found") for the subset of custom object names containing mass-noun stems. **Why deferred**: the proper fix is structural — the wrapper should query `metadata_query({kind: 'objects'})` to fetch both `nameSingular` and `namePlural` from server-side metadata and use them directly instead of inferring via pluralize. That requires a network round-trip per CRUD call (or a cache) AND breaks the current "either form routes correctly" contract for ambiguous-form objects. The mass-noun limitation is documented in the test suite (`crm.test.ts` "documents pluralize-mass-noun limitation" test) so it's mechanically visible to future implementers. Should be filed as a follow-up issue by the auditor.

## Supervisor revisions during implementation

- **2026-05-12 R1**: implementer halted on the `companyAnalytics` test assertion (plan asserted server's output `update_company_analytics`; wrapper produces `update_company_analytic` due to pluralize's mass-noun mishandling). Supervisor revised:
  1. Replaced `companyAnalytics` → `companyMetric` in the multi-word test cases (`crm.test.ts` line 42).
  2. Replaced `{singular: 'companyAnalytics', plural: 'companyAnalytics'}` → `{singular: 'companyMetric', plural: 'companyMetrics'}` in `crm-coverage.test.ts` `CAMEL_CASE_INPUTS` (line 55).
  3. Added a new "documents pluralize-mass-noun limitation" test in `crm.test.ts` (after the camelCase test) that asserts the actual (buggy) wrapper output for `companyAnalytics` and documents the bug class in a comment. This makes the limitation mechanically visible.
  4. Added the pluralize-mass-noun bug class to "Out of scope" above. The auditor should consider filing this as a follow-up MEDIUM issue per the standard pipeline.

- **2026-05-12 R2**: integration test `beforeAll`/`afterAll` failed because the plan assumed `metadata_apply_plan` supports a `DELETE_OBJECT` op — it does NOT (apply_plan is build-up only, no teardown ops). Supervisor revised:
  1. Replaced both `DELETE_OBJECT` apply_plan calls (defensive cleanup in `beforeAll`, fixture teardown in `afterAll`) with direct `client.graphqlMutation('mutation { deleteOneObject(input: { id }) { id } }', vars, 'metadata')` calls. The `deleteOneObject` GraphQL mutation is the only Twenty mechanism for hard-deleting object metadata; verified live via the captured `metadata-graphql.json` fixture.
  2. Added a comment in both call sites explaining why apply_plan can't be used and pointing future maintainers at the direct mutation.

- **2026-05-12 R3**: `CREATE_OBJECT` `applied[0].result.id` returned undefined — the plan assumed a flat `result.id` shape, but apply_plan actually wraps each mutation's inner-tool response as a nested MCP `ToolsCallResult` (`{content: [{type:'text', text: '<JSON-string-with-id>'}], isError: false}`). Supervisor revised: the `beforeAll` now unwraps the nested response correctly — `parsed.applied[0].result.content[0].text` is parsed as JSON, then `.id` is extracted. Added an error message that includes the raw inner payload if parsing fails. This nested-response pattern is consistent across all apply_plan ops (a future MEDIUM follow-up could centralise this unwrap into a helper).

After all three revisions, all 205 unit tests pass AND all 16 integration tests pass (including the 6 new issue-#11 tests).

## Verification (end-to-end)

The verification is the integration test suite — run against the local docker stack with the same workspace + API key the user provisioned earlier.

**Sequence:**

1. **Supervisor verifies stack state, brings up only if needed** (NOT the agent — the hardened agent prompt forbids autonomous infra mutation):
   ```bash
   # Step 1a: check what's running first (cheap, read-only).
   docker compose -f packages/twenty-docker/docker-compose.deploy.yml ps \
     --format '{{.Name}}\t{{.Status}}'

   # Step 1b: if `twenty-deploy-server-1 Up (healthy)` AND `twenty-deploy-mcp-1 Up` appear,
   # the stack is already up — SKIP `setup-dev-env.sh`. Proceed to step 1c.
   # Otherwise, bring up the stack (idempotent for already-running services):
   bash packages/twenty-utils/setup-dev-env.sh

   # Step 1c: verify all services healthy regardless of whether we just brought them up:
   curl -sf http://localhost:4440/healthz
   curl -sf -X POST http://localhost:4441/mcp \
     -H "Authorization: Bearer $(grep '^TWENTY_API_KEY=' packages/twenty-mcp/.env.local | cut -d= -f2-)" \
     -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
     >/dev/null && echo "MCP ok"
   ```
   No new containers are spawned if the stack is already running and healthy. `setup-dev-env.sh`'s `docker compose up -d` invocation is itself idempotent (no-op on already-running services), but skipping it when not needed avoids unnecessary noise.

2. **Implementer applies the fix** (via `/implement-issue-fix`). Agent's hardened prompt confirms stack is up via `docker compose ps`; halts if not. Applies the regex change + adds unit tests + adds the new integration test block.

3. **Pre-fix repro verification (highly recommended)**: BEFORE the regex fix lands, run the new integration test once. The `search_records` assertion must fail with the expected `Tool "find_mcpauditfixtures" not found` error — proving the test is non-vacuous. Then apply the fix; re-run; all 6 new tests pass.

4. **Unit + coverage verification** — see "Unit-level mechanical verifiers" above. All ~211 unit tests green.

5. **Integration verification (PRIMARY mechanical gate for this fix)**:
   ```bash
   cd packages/twenty-mcp
   TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
     npx dotenv -e .env.local -- npx jest --testPathPatterns='round-trip.test.ts' --config jest.config.ts
   ```
   Expect: 16 tests pass (10 pre-existing + 6 new). The new `integration: multi-word custom object CRUD (issue #11)` block creates a `mcpAuditFixture` object, runs all 5 CRUD ops (+1 singular-form assertion), then deletes the fixture in `afterAll`. End-to-end proof against the actual server.

6. **Cleanup verification** — after the suite, confirm the `mcpAuditFixture` object is absent from the workspace. The `afterAll` should handle this; the supervisor's R1 re-run double-checks.

7. **Audit hand-off**: `/audit-fix packages/twenty-mcp/plans/<plan-path>.md` per the standard pipeline. Adversarial reading should scrutinise: (a) the regex's handling of edge cases (consecutive capitals, leading digits) — failure-mode #1 documents a known limitation; (b) the integration test's `beforeAll` and `afterAll` resilience to mid-test failures (orphaned fixture object if `afterAll` is skipped); (c) the drift-gate signature regex's specificity (should it be tighter or looser?); (d) whether the curated `CAMEL_CASE_INPUTS` list in `crm-coverage.test.ts` covers enough patterns to confidently catch real-world drift.

## Implementation notes — blocked
> Blocked: 2026-05-12

### First failure

**Command:** `cd packages/twenty-mcp && npx jest src/__tests__/crm.test.ts --config jest.config.ts`

**Exit code:** 1

**Full output:**
```
FAIL src/__tests__/crm.test.ts
  innerToolName — Twenty per-object tool naming
    ✓ search uses find_<plural> (6 ms)
    ✓ get uses find_one_<singular> (1 ms)
    ✓ create / update / delete use <op>_<singular> (1 ms)
    ✓ normalizes spaces and case
    ✕ handles camelCase multi-word object names (issue #11) (2 ms)
    ✓ handles already-snake_cased forms (existing workaround still works)
    ✓ handles PascalCase and space-separated forms (wrapper advertised flexibility) (1 ms)

  ● innerToolName — Twenty per-object tool naming › handles camelCase multi-word object names (issue #11)

    expect(received).toBe(expected) // Object.is equality

    Expected: "update_company_analytics"
    Received: "update_company_analytic"

      40 |     expect(innerToolName('get', 'schemaChangeAudit')).toBe('find_one_schema_change_audit');
      41 |     expect(innerToolName('create', 'customerHealth')).toBe('create_customer_health');
    > 42 |     expect(innerToolName('update', 'companyAnalytics')).toBe('update_company_analytics');
         |                                                         ^
      43 |     expect(innerToolName('delete', 'salesActivity')).toBe('delete_sales_activity');

Tests: 1 failed, 15 passed, 16 total
```

### Hypothesis

The plan's assertion `expect(innerToolName('update', 'companyAnalytics')).toBe('update_company_analytics')` is wrong. The `normalize()` function computes `singular(snakeified)` for create/update/delete operations. After applying the regex fix, `'companyAnalytics'` → snakeified = `'company_analytics'`. Then `pluralize.singular('company_analytics')` = `'company_analytic'` (NOT `'company_analytics'`), because `pluralize` treats `analytics` as a count word and (incorrectly) singularizes it to `analytic`. The plan did not account for this irregularity in the `pluralize` library.

**Root cause:** `analytics` is an irregular uncountable noun that the `pluralize` library mishandles: `singular('analytics')` = `'analytic'`. The actual wrapper behavior for `innerToolName('update', 'companyAnalytics')` is `'update_company_analytic'`, not `'update_company_analytics'`.

**Wider impact:** The server registers the tool as `update_company_analytics` (from `camelToSnakeCase('companyAnalytics')` = `'company_analytics'`), but the wrapper produces `'update_company_analytic'`. This means `companyAnalytics`-type object names with the `analytics` suffix still fail to route correctly — a residual bug not fixed by the regex change. However, this is a pre-existing issue with irregular pluralization, not introduced by this PR.

**What the supervisor must decide:**

1. Whether to update the test assertion in `crm.test.ts` from `'update_company_analytics'` to `'update_company_analytic'` (reflecting actual behavior, which is still broken for this specific edge case), OR
2. Whether to also fix the `companyAnalytics` edge case in `normalize()` (e.g. by not calling `pluralize.singular` when the input already appears to be singular), OR
3. Whether to replace the `companyAnalytics` example in the test with a word that `pluralize` handles correctly (e.g. `'companyMetric'` → `'update_company_metric'`).

Option 3 is the minimum-blast-radius path: replace `'companyAnalytics'` with `'companyMetric'` (or similar) in the crm.test.ts assertion, since the plan's goal is to test the camelCase boundary regex, not `pluralize`'s handling of uncountable nouns. The `CAMEL_CASE_INPUTS` list in `crm-coverage.test.ts` should also be reviewed for the same issue (`companyAnalytics` is listed there too).

**Files changed before blocking:**
- `packages/twenty-mcp/src/tools/crm.ts` — `normalize()` fix applied (correct)
- `packages/twenty-mcp/src/__tests__/crm.test.ts` — new assertions added (one is incorrect)
- `packages/twenty-mcp/src/__tests__/crm-coverage.test.ts` — NEW file created
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` — integration block added

## Implementation notes (resolved post-supervisor-revision)

> Implemented: 2026-05-12

### Supervisor resolution

Picked **Option 3** from the implementer's "Hypothesis" section (above) AND added a separate test that documents the pluralize-mass-noun limitation. Plus addressed two further blockers in the integration test (apply_plan doesn't support DELETE_OBJECT; CREATE_OBJECT response is nested). See `## Supervisor revisions during implementation` above for the full chain (R1, R2, R3).

### Final files changed

- `packages/twenty-mcp/src/tools/crm.ts` — `normalize()` replaced with the camelCase-aware regex (from the plan's "## Code change" section).
- `packages/twenty-mcp/src/__tests__/crm.test.ts` — extended with 4 new test blocks: camelCase multi-word (issue #11), snake_cased forms, PascalCase/space-separated, AND the new "documents pluralize-mass-noun limitation" test.
- `packages/twenty-mcp/src/__tests__/crm-coverage.test.ts` — NEW. Reads `twenty-shared/src/utils/strings/camelToSnakeCase.ts` source at test time; signature-regex drift gate + 30 wrapper-vs-server equivalence assertions (10 inputs × 3 ops).
- `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` — new `describeIfDestructive` block: creates a `mcpAuditFixture` 2-word custom object via apply_plan, runs all 5 CRUD ops + singular-form variant against it, deletes via direct `deleteOneObject` GraphQL mutation in afterAll. Defensive cleanup in `beforeAll` handles stale fixtures from prior crashed runs.

### Test results (verbatim)

**1. Unit suite — `npx jest src/__tests__/crm.test.ts --config jest.config.ts`**
```
Test Suites: 1 passed, 1 total
Tests:       17 passed, 17 total
Time:        1.178 s
```
(17 = 10 pre-existing + 7 new: camelCase multi-word + snake_cased + PascalCase/space + pluralize-limitation-documentation)

**2. Coverage drift gate — `npx jest src/__tests__/crm-coverage.test.ts --config jest.config.ts`**
```
Test Suites: 1 passed, 1 total
Tests:       30 passed, 30 total
Time:        1.153 s
```
(30 = 10 camelCase inputs × 3 ops, all confirming wrapper matches canonical `camelToSnakeCase`)

**3. Full unit suite — `npx jest --config jest.config.ts`**
```
Test Suites: 16 passed, 16 total
Tests:       205 passed, 205 total
Time:        15.449 s
```

**4. Integration — `TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- npx jest --testPathPatterns='round-trip.test.ts' --config jest.config.ts`**
```
Test Suites: 1 passed, 1 total
Tests:       16 passed, 16 total
Time:        3.814 s
```
(16 = 10 pre-existing + 6 new issue-#11 block: search/create/get/update/delete + singular-form variant)

### Surprises

1. **pluralize mass-noun mishandling** (caught during round 1 of supervisor revisions): the plan asserted server-side output for `companyAnalytics`, but `pluralize.singular('company_analytics')` returns `'company_analytic'`. The plan's regex fix doesn't address this — the bug is in the `pluralize` library's handling of English mass nouns (analytics, data, news, series, etc.). Documented in plan's "Out of scope" + made mechanically visible via the new "documents pluralize-mass-noun limitation" test. Filed for follow-up.

2. **apply_plan has no teardown ops** (R2): the plan's integration test used `op: 'DELETE_OBJECT'` for fixture cleanup. apply_plan's `ApplyPlanOpKind` type does NOT include any delete ops (only CREATE_/UPDATE_/UPSERT_/REVOKE for api keys/permissions). TypeScript caught this at compile time. Worked around by using `client.graphqlMutation` directly to call `deleteOneObject` on `/metadata`. The fact that the wrapper exposes no high-level "delete object" tool is itself a gap — a follow-up could add `metadata_delete_object` to fill it.

3. **apply_plan response is nested** (R3): the plan assumed `applied[0].result.id` was a flat lookup. Actually `applied[0].result` is itself an MCP `ToolsCallResult` with `content[0].text` being a JSON string containing the created entity's payload. So getting the id requires `JSON.parse(parsed.applied[0].result.content[0].text).id`. This nested-unwrap pattern is consistent across all apply_plan ops and would benefit from a helper (filed as Surprise for the auditor).

4. **Object-name collision avoidance**: the integration test's `beforeAll` defensive cleanup deletes any stale `mcpAuditFixture` from prior crashed runs. Verified this works by leaving a probe object on the stack (`mcpProbeObj`) during shape investigation; the cleanup query found and removed it. Pattern is robust to crash-during-CRUD scenarios.

## Audit annotations (post-audit-round-1)

- **Failure-mode #1 correction**: the plan's failure-mode #1 claims "consecutive-capital object names are not producible via the standard Twenty UI/API." This is incorrect for lowercase-first names with embedded acronyms (e.g. `iOSDevice`, `myAPIKey`, `userIPAddress`). Twenty's server-side validation regex is `/^[a-z][a-zA-Z0-9]*$/` (only the first character must be lowercase) — so embedded-acronym names ARE producible and reachable via `createOneObject`. The wrapper's regex `([a-z0-9])([A-Z])` only inserts ONE underscore at the first lowercase→capital boundary, while server's `camelToSnakeCase` inserts before EVERY capital — they diverge for these names. See follow-up issue #12 for the bug class. The regex fix in this plan handles the common case correctly; the embedded-acronym case is filed as separate work and shares a fix shape with #13 (the pluralize-mass-noun follow-up).

> Audit round 1: clean-with-mediums — see issue-11-inner-tool-name-camelcase-boundary-audit-round-1.md
> Audit round 1: medium defects → filed issues #12 (embedded-acronym camelCase), #13 (pluralize mass-noun)
> Audit round 1: LOW absorbed pre-commit (trivial-in-place): removed unused pluralize import from crm-coverage.test.ts
> Audit round 1: LOW absorbed pre-commit (trivial-in-place): appended Audit annotations correcting failure-mode #1 (embedded acronyms ARE producible)
> Audit round 1: LOW backlogged (cosmetic): standardize throw vs it.skip pattern across *-coverage.test.ts files
