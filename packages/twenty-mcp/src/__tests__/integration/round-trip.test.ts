/**
 * Live-fire integration test — DESTRUCTIVE OPS. Run against LOCAL docker-compose
 * Twenty only. Triple-gated:
 *   - TWENTY_MCP_INTEGRATION=1     (enables the suite)
 *   - INCLUDE_INTEGRATION=1         (jest config opts the path in)
 *   - MCP_INTEGRATION_DESTRUCTIVE_OK=1 (acknowledges destructive ops)
 *
 * Plus a runtime safety check: if TWENTY_BASE_URL points at the VPS host, the
 * suite refuses to start. VPS = production. NEVER run destructive ops there.
 *
 * Run:
 *   docker compose -f packages/twenty-docker/docker-compose.deploy.yml up -d
 *   # mint a LOCAL api key from http://localhost:4440 → Settings → Developers
 *   TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 \
 *   MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
 *     npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts
 *
 * The companion vps-smoke.test.ts is the read-only counterpart for production.
 */
import { buildCrmHandlers } from '../../tools/crm';
import { buildMetadataHandlers } from '../../tools/metadata';
import { buildNoteTargetHandlers } from '../../tools/note-targets';
import { TwentyMcpClient, type ToolsCallResult } from '../../twenty-mcp-client';
import { parseInnerOrGraphqlArray } from '../../utils/parse-metadata-array';
import { viewFilterRowSchema } from '../../utils/view-filter-row.schema';

const enabled = process.env.TWENTY_MCP_INTEGRATION === '1';
const destructiveOk = process.env.MCP_INTEGRATION_DESTRUCTIVE_OK === '1';

const baseUrl = process.env.TWENTY_BASE_URL ?? 'http://localhost:4440';
const apiKey = process.env.TWENTY_API_KEY ?? '';

// Runtime safety: refuse to run destructive ops against anything that doesn't
// look like a local Twenty. The check is intentionally loud — if you're seeing
// this fire, your env is misconfigured and you were ABOUT to write to prod.
const PROD_HOST_PATTERNS = [
  /^https?:\/\/[\d.]+(:\d+)?\/?$/, // any IP-based host (the VPS is 100.115.12.29)
  /\.example\.com/i,
  /\.production\./i,
  /[a-z]+\.crm\./i,
];

const isLikelyLocalUrl = (url: string): boolean => {
  if (/localhost|127\.0\.0\.1|::1/.test(url)) return true;
  for (const pat of PROD_HOST_PATTERNS) {
    if (pat.test(url)) return false;
  }
  // be conservative — anything that's not localhost defaults to "treat as prod"
  return false;
};

if (enabled && destructiveOk && !isLikelyLocalUrl(baseUrl)) {
  throw new Error(
    `[round-trip.test.ts] REFUSING TO START: TWENTY_BASE_URL=${baseUrl} does not look like a local Twenty, ` +
      `but MCP_INTEGRATION_DESTRUCTIVE_OK=1 was set. Destructive integration tests must run only against local docker-compose Twenty. ` +
      `Use vps-smoke.test.ts for read-only verification on the VPS.`,
  );
}

/**
 * Twenty's execute_tool wraps the inner result inside a JSON string under
 * content[0].text. Parse it so tests can assert on `success` / `result.id` etc.
 */
const unwrap = (
  r: ToolsCallResult,
): { success: boolean; result?: any; message?: string } => {
  const block = r.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected text block in tool result');
  }
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error(
      `could not parse Twenty response: ${block.text.slice(0, 200)}`,
    );
  }
};

// Destructive describe blocks below ALSO check destructiveOk, in case the
// suite is loaded with TWENTY_MCP_INTEGRATION=1 alone (read-only intent).
const describeIfDestructive =
  enabled && destructiveOk ? describe : describe.skip;

describeIfDestructive('integration: people CRUD round-trip', () => {
  if (enabled && destructiveOk && !apiKey) {
    throw new Error('TWENTY_MCP_INTEGRATION=1 but TWENTY_API_KEY is not set');
  }

  const client = new TwentyMcpClient({ baseUrl, apiKey });
  const crm = buildCrmHandlers(client);

  let createdId: string | undefined;
  const uniq = `mcp-contract-${Date.now()}`;

  it('creates a person', async () => {
    const r = unwrap(
      await crm.createRecord({
        object: 'person',
        data: { name: { firstName: 'Audit', lastName: uniq } },
      }),
    );
    expect(r.success).toBe(true);
    expect(r.result?.id).toBeTruthy();
    createdId = r.result.id as string;
  });

  it('finds the person via search filter (top-level field filters)', async () => {
    const r = unwrap(
      await crm.searchRecords({
        object: 'person',
        filter: { name: { lastName: { eq: uniq } } },
        limit: 5,
      }),
    );
    expect(r.success).toBe(true);
    expect(Array.isArray(r.result?.records ?? r.result)).toBe(true);
  });

  it('gets the person by id', async () => {
    if (!createdId)
      throw new Error('createdId not set; create test must succeed first');
    const r = unwrap(await crm.getRecord({ object: 'person', id: createdId }));
    expect(r.success).toBe(true);
    // Twenty's find_one_<sg> returns {result: {records: [<record>]}} — a wrapped
    // single-element array, not the record directly. Document this in the tool
    // description so agents don't make the same mistake.
    const records = (r.result as { records?: Array<{ id: string }> })?.records;
    expect(Array.isArray(records)).toBe(true);
    expect(records?.[0]?.id).toBe(createdId);
  });

  it('updates the person (id + spread data)', async () => {
    if (!createdId) throw new Error('createdId not set');
    const r = unwrap(
      await crm.updateRecord({
        object: 'person',
        id: createdId,
        data: { jobTitle: 'Audit Subject' },
      }),
    );
    expect(r.success).toBe(true);
    // Twenty's update_<sg> returns a SLIM response: {result: {id}} (not the
    // updated record). To verify the field was applied, follow up with a
    // separate find_one_<sg>.
    expect((r.result as { id?: string })?.id).toBe(createdId);
    const verify = unwrap(
      await crm.getRecord({ object: 'person', id: createdId }),
    );
    const records = (
      verify.result as { records?: Array<{ jobTitle?: string }> }
    )?.records;
    expect(records?.[0]?.jobTitle).toBe('Audit Subject');
  });

  it('deletes the person', async () => {
    if (!createdId) throw new Error('createdId not set');
    const r = unwrap(
      await crm.deleteRecord({ object: 'person', id: createdId }),
    );
    expect(r.success).toBe(true);
  });
});

/**
 * link_note_to_record verifies the GraphQL bypass works against a real Twenty.
 * If this passes, the workflow-gate workaround is genuinely effective.
 */
describeIfDestructive(
  'integration: link_note_to_record (GraphQL bypass)',
  () => {
    if (enabled && destructiveOk && !apiKey) {
      throw new Error('TWENTY_MCP_INTEGRATION=1 but TWENTY_API_KEY is not set');
    }

    const client = new TwentyMcpClient({ baseUrl, apiKey });
    const crm = buildCrmHandlers(client);
    const noteTargets = buildNoteTargetHandlers(client);

    let companyId: string | undefined;
    let noteId: string | undefined;
    const uniq = `mcp-link-${Date.now()}`;

    it('creates a company', async () => {
      const r = unwrap(
        await crm.createRecord({
          object: 'company',
          data: { name: `MCP-Link-Co-${uniq}` },
        }),
      );
      expect(r.success).toBe(true);
      companyId = r.result.id as string;
    });

    it('creates a note (record-crud path — note is NOT isSystem so it works)', async () => {
      const r = unwrap(
        await crm.createRecord({
          object: 'note',
          data: {
            title: `Eval ${uniq}`,
            bodyV2: { markdown: 'integration test' },
          },
        }),
      );
      expect(r.success).toBe(true);
      noteId = r.result.id as string;
    });

    it('links the note to the company via the GraphQL bypass', async () => {
      if (!noteId || !companyId) throw new Error('noteId / companyId not set');
      const r = unwrap(
        await noteTargets.linkNoteToRecord({
          noteId,
          targetCompanyId: companyId,
        }),
      );
      expect(r.success).toBe(true);
      // result is the GraphQL response { createNoteTarget: {...} }
      const noteTarget = (r.result as { createNoteTarget?: any })
        .createNoteTarget;
      expect(noteTarget?.noteId).toBe(noteId);
      expect(noteTarget?.targetCompanyId).toBe(companyId);
    });

    it('cleanup: delete the company and note', async () => {
      if (companyId)
        await crm.deleteRecord({ object: 'company', id: companyId });
      if (noteId) await crm.deleteRecord({ object: 'note', id: noteId });
    });
  },
);

/**
 * Operand validation rejection test.
 * Verifies that apply_plan rejects an invalid operand BEFORE it reaches Twenty.
 * This test is deliberately non-destructive: the bad filter is rejected by the
 * wrapper layer and never written to Twenty.
 *
 * The DATE_TIME field id is discovered dynamically in beforeAll via a focused
 * two-step query: first fetch the 'company' object id, then fetch only company
 * fields (objectMetadataId-filtered). This eliminates the page-boundary risk of
 * a hard limit=200 cap: company has far fewer than 200 fields and the list will
 * never be truncated. Any workspace with a default 'company' object will work.
 */
describeIfDestructive(
  'integration: operand validation — invalid operand rejected before reaching Twenty',
  () => {
    if (enabled && destructiveOk && !apiKey) {
      throw new Error('TWENTY_MCP_INTEGRATION=1 but TWENTY_API_KEY is not set');
    }

    const client = new TwentyMcpClient({ baseUrl, apiKey });
    // Use a non-existent viewId — the validation fails before it's needed
    const FAKE_VIEW_ID = '00000000-0000-0000-0000-000000000000';

    // Discovered dynamically in beforeAll — no hardcoded UUID.
    let DATE_TIME_FIELD_ID: string;

    beforeAll(async () => {
      if (!enabled || !destructiveOk) return;
      const metadata = buildMetadataHandlers(client, apiKey);

      // Step 1: find the 'company' object id (focused — never paginated).
      const objectsResult = await metadata.metadataQuery({
        kind: 'objects',
        args: { limit: 50 },
      });
      const objectsText = (
        objectsResult.content[0] as { type: 'text'; text: string }
      ).text;
      const objects = parseInnerOrGraphqlArray<{
        id: string;
        nameSingular: string;
      }>(objectsText);
      const companyObject = objects.find((o) => o.nameSingular === 'company');
      if (!companyObject) {
        throw new Error(
          'round-trip.test: no "company" object found in workspace metadata. ' +
            'Ensure the local Twenty stack has stock data (default workspace).',
        );
      }

      // Step 2: fetch ONLY company fields (objectMetadataId-filtered).
      // A focused object always has far fewer than 200 fields — no page-boundary risk.
      const fieldsResult = await metadata.metadataQuery({
        kind: 'fields',
        args: { objectMetadataId: companyObject.id },
      });
      const fieldsText = (
        fieldsResult.content[0] as { type: 'text'; text: string }
      ).text;
      const fields = parseInnerOrGraphqlArray<{ id: string; type: string }>(
        fieldsText,
      );
      const dateTimeField = fields.find((f) => f.type === 'DATE_TIME');
      if (!dateTimeField) {
        // Disambiguate "stock data missing" from "API shape changed" — the parsed shape
        // is included so a future shape drift produces a clearer signal than a misleading
        // "reseed" instruction.
        const raw: unknown = JSON.parse(fieldsText);
        const shape = Array.isArray(raw)
          ? `array of ${raw.length}`
          : `top-level object with keys [${Object.keys(raw as object).join(', ')}]`;
        throw new Error(
          `round-trip.test: no DATE_TIME field found on company object (parsed: ${shape}). ` +
            `Either reseed stock data, OR investigate response-shape drift.`,
        );
      }
      DATE_TIME_FIELD_ID = dateTimeField.id;
    });

    it('apply_plan CREATE_VIEW_FILTER with GREATER_THAN_OR_EQUAL on DATE_TIME is rejected by the proxy (never reaches Twenty)', async () => {
      const metadata = buildMetadataHandlers(client, apiKey);

      const result = await metadata.metadataApplyPlan({
        mutations: [
          {
            key: 'test_invalid_operand',
            op: 'CREATE_VIEW_FILTER',
            args: {
              viewId: FAKE_VIEW_ID,
              fieldMetadataId: DATE_TIME_FIELD_ID,
              operand: 'GREATER_THAN_OR_EQUAL',
              value: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      });

      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      ) as {
        totalMutations: number;
        applied: Array<{ key: string }>;
        failed: { op: string; error: string } | null;
      };

      // The plan fails at the first (only) mutation
      expect(parsed.totalMutations).toBe(1);
      expect(parsed.applied).toHaveLength(0);
      expect(parsed.failed?.op).toBe('CREATE_VIEW_FILTER');
      expect(parsed.failed?.error).toMatch(
        /Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME/,
      );
      // result.isError should be true since failed is non-null
      expect(result.isError).toBe(true);

      // Independent verification: query Twenty's view_filters and assert no row
      // landed with the bad operand on the DATE_TIME field. Without this step, a
      // future regression that bypasses the wrapper's rejection would still pass
      // the assertions above (Twenty would also reject — with a different error).
      // Uses parseInnerOrGraphqlArray so the verification is non-vacuous regardless
      // of whether view_filters routes through inner_tool or graphql transport.
      const viewFiltersResult = await metadata.metadataQuery({
        kind: 'view_filters',
        args: { limit: 200 },
      });
      const viewFiltersText = (
        viewFiltersResult.content[0] as { type: 'text'; text: string }
      ).text;
      const rawRows = parseInnerOrGraphqlArray<unknown>(viewFiltersText);
      const viewFilterRows = viewFilterRowSchema.array().parse(rawRows);
      const leakedRows = viewFilterRows.filter(
        (row) =>
          row.fieldMetadataId === DATE_TIME_FIELD_ID &&
          row.operand === 'GREATER_THAN_OR_EQUAL',
      );
      expect(leakedRows).toEqual([]);
    });
  },
);

/**
 * Multi-word custom object CRUD — issue #11.
 * Creates a 2-word camelCase custom object (`mcpAuditFixture`), runs all 5 CRUD
 * operations against it, then deletes it in afterAll. Proves the wrapper's
 * camelCase-aware normalize() correctly routes to the server's camelToSnakeCase-
 * registered inner tools (find_mcp_audit_fixtures, not find_mcpauditfixtures).
 */
describeIfDestructive(
  'integration: multi-word custom object CRUD (issue #11)',
  () => {
    if (enabled && destructiveOk && !apiKey) {
      throw new Error('TWENTY_MCP_INTEGRATION=1 but TWENTY_API_KEY is not set');
    }

    const client = new TwentyMcpClient({ baseUrl, apiKey });
    const objNameSingular = 'mcpAuditFixture'; // 2-word camelCase — provably exercises the bug
    const objNamePlural = 'mcpAuditFixtures';
    let objectMetadataId: string | undefined;
    let createdRecordId: string | undefined;

    const metadata = buildMetadataHandlers(client, apiKey);
    const crm = buildCrmHandlers(client);

    beforeAll(async () => {
      if (!enabled || !destructiveOk) return;
      // Defensive cleanup: if a prior test run crashed before afterAll, the
      // mcpAuditFixture object may still exist on the workspace. Query first,
      // delete if found, then create fresh. This keeps the test idempotent
      // across re-runs without requiring a manual `docker compose down -v`.
      const existing = await metadata.metadataQuery({
        kind: 'objects',
        args: { limit: 200 },
      });
      const existingText = (
        existing.content[0] as { type: 'text'; text: string }
      ).text;
      const existingObjects = parseInnerOrGraphqlArray<{
        id: string;
        nameSingular: string;
      }>(existingText);
      const stale = existingObjects.find(
        (o) => o.nameSingular === objNameSingular,
      );
      if (stale) {
        // metadata_apply_plan does NOT support DELETE_OBJECT — use a direct
        // GraphQL mutation on the /metadata endpoint instead. This is the only
        // mechanism Twenty currently exposes for hard-deleting object metadata.
        await client.graphqlMutation(
          'mutation DeleteObject($input: DeleteOneObjectInput!) { deleteOneObject(input: $input) { id } }',
          { input: { id: stale.id } },
          'metadata',
        );
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
              description:
                'Temporary fixture for issue #11 integration test. Safe to delete.',
            },
          },
        ],
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      if (parsed.failed) {
        throw new Error(
          `round-trip.test: failed to bootstrap mcpAuditFixture object: ${JSON.stringify(parsed.failed)}. ` +
            `If a stale fixture exists despite the defensive cleanup above, investigate manually via ` +
            `metadata_query({kind:'objects'}) and the deleteOneObject GraphQL mutation.`,
        );
      }
      // apply_plan wraps each mutation's result: the inner-tool response is itself
      // an MCP ToolsCallResult ({content: [{type:'text', text: '<JSON>'}], isError}).
      // Extract the actual created-object payload from that nested text field.
      const appliedEntry = parsed.applied?.[0]?.result as
        | { content?: Array<{ type: string; text: string }>; isError?: boolean }
        | undefined;
      const innerText = appliedEntry?.content?.[0]?.text;
      if (!innerText) {
        throw new Error(
          `round-trip.test: CREATE_OBJECT applied entry has no inner text. Got: ${JSON.stringify(parsed.applied?.[0])}`,
        );
      }
      const innerObject = JSON.parse(innerText) as { id?: string };
      objectMetadataId = innerObject.id;
      if (!objectMetadataId) {
        throw new Error(
          `round-trip.test: CREATE_OBJECT succeeded but no objectMetadataId returned. Inner payload: ${innerText}`,
        );
      }
    });

    afterAll(async () => {
      // Cleanup: delete the fixture object so the workspace returns to its pre-test state.
      // metadata_apply_plan does NOT support DELETE_OBJECT (apply_plan is build-up only,
      // not teardown). Use a direct GraphQL mutation on the /metadata endpoint.
      if (objectMetadataId) {
        await client.graphqlMutation(
          'mutation DeleteObject($input: DeleteOneObjectInput!) { deleteOneObject(input: $input) { id } }',
          { input: { id: objectMetadataId } },
          'metadata',
        );
      }
    });

    it('search_records on multi-word object name routes to find_mcp_audit_fixtures (NOT find_mcpauditfixtures)', async () => {
      const result = await crm.searchRecords({
        object: objNamePlural,
        limit: 5,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
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
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
      expect(parsed.result?.id).toBeTruthy();
      createdRecordId = parsed.result.id as string;
    });

    it('get_record on multi-word object name routes to find_one_mcp_audit_fixture', async () => {
      if (!createdRecordId)
        throw new Error('createdRecordId not set — create test must precede');
      const result = await crm.getRecord({
        object: objNameSingular,
        id: createdRecordId,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
      const record = (parsed.result as { records?: Array<{ id: string }> })
        ?.records?.[0];
      expect(record?.id).toBe(createdRecordId);
    });

    it('update_record on multi-word object name routes to update_mcp_audit_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.updateRecord({
        object: objNameSingular,
        id: createdRecordId,
        data: { name: 'issue-11-test-row-updated' },
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });

    it('delete_record on multi-word object name routes to delete_mcp_audit_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.deleteRecord({
        object: objNameSingular,
        id: createdRecordId,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });

    it('also routes for singular-form input → search converts to plural correctly', async () => {
      const result = await crm.searchRecords({
        object: objNameSingular,
        limit: 5,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true); // resolveObjectNames resolves 'mcpAuditFixture' → find_mcp_audit_fixtures
    });
  },
);

/**
 * Embedded-acronym custom object CRUD — issue #12.
 * Creates a custom object with consecutive capital letters in nameSingular
 * (`myAPIKeyFixture`), runs all 5 CRUD operations, then deletes in afterAll.
 * Proves the wrapper's resolveObjectNames + camelToSnakeCase correctly routes
 * to the server's camelToSnakeCase-registered inner tools
 * (find_my_a_p_i_key_fixtures, NOT find_myapikeyfixtures).
 */
describeIfDestructive(
  'integration: embedded-acronym custom object CRUD (issue #12)',
  () => {
    if (enabled && destructiveOk && !apiKey) {
      throw new Error('TWENTY_MCP_INTEGRATION=1 but TWENTY_API_KEY is not set');
    }

    const client = new TwentyMcpClient({ baseUrl, apiKey });
    const objNameSingular = 'myAPIKeyFixture';
    const objNamePlural = 'myAPIKeyFixtures';
    let objectMetadataId: string | undefined;
    let createdRecordId: string | undefined;

    const metadata = buildMetadataHandlers(client, apiKey);
    const crm = buildCrmHandlers(client);

    beforeAll(async () => {
      if (!enabled || !destructiveOk) return;
      // Defensive cleanup: delete stale fixture if present from a prior crashed run.
      const existing = await metadata.metadataQuery({
        kind: 'objects',
        args: { limit: 200 },
      });
      const existingText = (
        existing.content[0] as { type: 'text'; text: string }
      ).text;
      const existingObjects = parseInnerOrGraphqlArray<{
        id: string;
        nameSingular: string;
      }>(existingText);
      const stale = existingObjects.find(
        (o) => o.nameSingular === objNameSingular,
      );
      if (stale) {
        await client.graphqlMutation(
          'mutation DeleteObject($input: DeleteOneObjectInput!) { deleteOneObject(input: $input) { id } }',
          { input: { id: stale.id } },
          'metadata',
        );
      }

      // Create the embedded-acronym custom object.
      const result = await metadata.metadataApplyPlan({
        mutations: [
          {
            key: 'create_my_api_key_fixture',
            op: 'CREATE_OBJECT',
            args: {
              nameSingular: objNameSingular,
              namePlural: objNamePlural,
              labelSingular: 'My API Key Fixture',
              labelPlural: 'My API Key Fixtures',
              icon: 'IconKey',
              description:
                'Temporary fixture for issue #12 integration test. Safe to delete.',
            },
          },
        ],
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      if (parsed.failed) {
        throw new Error(
          `round-trip.test: failed to bootstrap myAPIKeyFixture object: ${JSON.stringify(parsed.failed)}`,
        );
      }
      const appliedEntry = parsed.applied?.[0]?.result as
        | { content?: Array<{ type: string; text: string }>; isError?: boolean }
        | undefined;
      const innerText = appliedEntry?.content?.[0]?.text;
      if (!innerText) {
        throw new Error(
          `round-trip.test: CREATE_OBJECT applied entry has no inner text. Got: ${JSON.stringify(parsed.applied?.[0])}`,
        );
      }
      const innerObject = JSON.parse(innerText) as { id?: string };
      objectMetadataId = innerObject.id;
      if (!objectMetadataId) {
        throw new Error(
          `round-trip.test: CREATE_OBJECT succeeded but no objectMetadataId returned. Inner payload: ${innerText}`,
        );
      }
    });

    afterAll(async () => {
      if (objectMetadataId) {
        await client.graphqlMutation(
          'mutation DeleteObject($input: DeleteOneObjectInput!) { deleteOneObject(input: $input) { id } }',
          { input: { id: objectMetadataId } },
          'metadata',
        );
      }
    });

    it('search_records on embedded-acronym object routes to find_my_a_p_i_key_fixtures (NOT find_myapikeyfixtures)', async () => {
      const result = await crm.searchRecords({
        object: objNamePlural,
        limit: 5,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      // Before-fix failure mode: "Tool \"find_myapikeyfixtures\" not found"
      // After-fix: success with an empty result set on a fresh object.
      expect(parsed.success).toBe(true);
    });

    it('create_record on embedded-acronym object routes to create_my_a_p_i_key_fixture', async () => {
      const result = await crm.createRecord({
        object: objNameSingular,
        data: { name: 'issue-12-test-row' },
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
      expect(parsed.result?.id).toBeTruthy();
      createdRecordId = parsed.result.id as string;
    });

    it('get_record on embedded-acronym object routes to find_one_my_a_p_i_key_fixture', async () => {
      if (!createdRecordId)
        throw new Error('createdRecordId not set — create test must precede');
      const result = await crm.getRecord({
        object: objNameSingular,
        id: createdRecordId,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
      const record = (parsed.result as { records?: Array<{ id: string }> })
        ?.records?.[0];
      expect(record?.id).toBe(createdRecordId);
    });

    it('update_record on embedded-acronym object routes to update_my_a_p_i_key_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.updateRecord({
        object: objNameSingular,
        id: createdRecordId,
        data: { name: 'issue-12-test-row-updated' },
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });

    it('delete_record on embedded-acronym object routes to delete_my_a_p_i_key_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.deleteRecord({
        object: objNameSingular,
        id: createdRecordId,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });

    it('also routes for singular-form input (myAPIKeyFixture) → resolves to find_my_a_p_i_key_fixtures', async () => {
      const result = await crm.searchRecords({
        object: objNameSingular,
        limit: 5,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });
  },
);

/**
 * Mass-noun custom object CRUD — issue #13.
 * Creates a custom object whose nameSingular is a mass noun (`companyAnalyticsFixture`
 * uses nameSingular and namePlural with the same camelToSnakeCase result).
 * Proves the wrapper routes singular ops to create_company_analytics_fixture
 * (using server-stored nameSingular directly) NOT create_company_analytic_fixture
 * (what the old pluralize.singular would have produced).
 */
describeIfDestructive(
  'integration: mass-noun custom object CRUD (issue #13)',
  () => {
    if (enabled && destructiveOk && !apiKey) {
      throw new Error('TWENTY_MCP_INTEGRATION=1 but TWENTY_API_KEY is not set');
    }

    const client = new TwentyMcpClient({ baseUrl, apiKey });
    // Use a mass-noun stem: Twenty will store nameSingular='companyAnalyticsFixture'
    // and namePlural='companyAnalyticsFixtures'. The server uses camelToSnakeCase on
    // both: 'company_analytics_fixture' and 'company_analytics_fixtures'.
    // The old pluralize.singular('company_analytics_fixture') would have returned
    // 'company_analytic_fixture' — the wrong tool name.
    const objNameSingular = 'companyAnalyticsFixture';
    const objNamePlural = 'companyAnalyticsFixtures';
    let objectMetadataId: string | undefined;
    let createdRecordId: string | undefined;

    const metadata = buildMetadataHandlers(client, apiKey);
    const crm = buildCrmHandlers(client);

    beforeAll(async () => {
      if (!enabled || !destructiveOk) return;
      // Defensive cleanup.
      const existing = await metadata.metadataQuery({
        kind: 'objects',
        args: { limit: 200 },
      });
      const existingText = (
        existing.content[0] as { type: 'text'; text: string }
      ).text;
      const existingObjects = parseInnerOrGraphqlArray<{
        id: string;
        nameSingular: string;
      }>(existingText);
      const stale = existingObjects.find(
        (o) => o.nameSingular === objNameSingular,
      );
      if (stale) {
        await client.graphqlMutation(
          'mutation DeleteObject($input: DeleteOneObjectInput!) { deleteOneObject(input: $input) { id } }',
          { input: { id: stale.id } },
          'metadata',
        );
      }

      // Create the mass-noun custom object.
      const result = await metadata.metadataApplyPlan({
        mutations: [
          {
            key: 'create_company_analytics_fixture',
            op: 'CREATE_OBJECT',
            args: {
              nameSingular: objNameSingular,
              namePlural: objNamePlural,
              labelSingular: 'Company Analytics Fixture',
              labelPlural: 'Company Analytics Fixtures',
              icon: 'IconChartBar',
              description:
                'Temporary fixture for issue #13 integration test. Safe to delete.',
            },
          },
        ],
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      if (parsed.failed) {
        throw new Error(
          `round-trip.test: failed to bootstrap companyAnalyticsFixture object: ${JSON.stringify(parsed.failed)}`,
        );
      }
      const appliedEntry = parsed.applied?.[0]?.result as
        | { content?: Array<{ type: string; text: string }>; isError?: boolean }
        | undefined;
      const innerText = appliedEntry?.content?.[0]?.text;
      if (!innerText) {
        throw new Error(
          `round-trip.test: CREATE_OBJECT applied entry has no inner text. Got: ${JSON.stringify(parsed.applied?.[0])}`,
        );
      }
      const innerObject = JSON.parse(innerText) as { id?: string };
      objectMetadataId = innerObject.id;
      if (!objectMetadataId) {
        throw new Error(
          `round-trip.test: CREATE_OBJECT succeeded but no objectMetadataId returned. Inner payload: ${innerText}`,
        );
      }
    });

    afterAll(async () => {
      if (objectMetadataId) {
        await client.graphqlMutation(
          'mutation DeleteObject($input: DeleteOneObjectInput!) { deleteOneObject(input: $input) { id } }',
          { input: { id: objectMetadataId } },
          'metadata',
        );
      }
    });

    it('search_records on mass-noun object routes to find_company_analytics_fixtures (NOT find_company_analytic_fixtures)', async () => {
      const result = await crm.searchRecords({
        object: objNamePlural,
        limit: 5,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });

    it('create_record routes to create_company_analytics_fixture (NOT create_company_analytic_fixture, issue #13)', async () => {
      const result = await crm.createRecord({
        object: objNameSingular,
        data: { name: 'issue-13-test-row' },
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      // Before-fix failure mode: "Tool \"create_company_analytic_fixture\" not found"
      // After-fix: routes to create_company_analytics_fixture via server-stored nameSingular.
      expect(parsed.success).toBe(true);
      expect(parsed.result?.id).toBeTruthy();
      createdRecordId = parsed.result.id as string;
    });

    it('get_record routes to find_one_company_analytics_fixture (NOT find_one_company_analytic_fixture)', async () => {
      if (!createdRecordId)
        throw new Error('createdRecordId not set — create test must precede');
      const result = await crm.getRecord({
        object: objNameSingular,
        id: createdRecordId,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
      const record = (parsed.result as { records?: Array<{ id: string }> })
        ?.records?.[0];
      expect(record?.id).toBe(createdRecordId);
    });

    it('update_record routes to update_company_analytics_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.updateRecord({
        object: objNameSingular,
        id: createdRecordId,
        data: { name: 'issue-13-test-row-updated' },
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });

    it('delete_record routes to delete_company_analytics_fixture', async () => {
      if (!createdRecordId) throw new Error('createdRecordId not set');
      const result = await crm.deleteRecord({
        object: objNameSingular,
        id: createdRecordId,
      });
      const parsed = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      );
      expect(parsed.success).toBe(true);
    });
  },
);
