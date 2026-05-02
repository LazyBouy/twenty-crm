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
import { buildNoteTargetHandlers } from '../../tools/note-targets';
import { TwentyMcpClient, type ToolsCallResult } from '../../twenty-mcp-client';

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
const unwrap = (r: ToolsCallResult): { success: boolean; result?: any; message?: string } => {
  const block = r.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected text block in tool result');
  }
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error(`could not parse Twenty response: ${block.text.slice(0, 200)}`);
  }
};

// Destructive describe blocks below ALSO check destructiveOk, in case the
// suite is loaded with TWENTY_MCP_INTEGRATION=1 alone (read-only intent).
const describeIfDestructive = enabled && destructiveOk ? describe : describe.skip;

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
    if (!createdId) throw new Error('createdId not set; create test must succeed first');
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
    const verify = unwrap(await crm.getRecord({ object: 'person', id: createdId }));
    const records = (verify.result as { records?: Array<{ jobTitle?: string }> })?.records;
    expect(records?.[0]?.jobTitle).toBe('Audit Subject');
  });

  it('deletes the person', async () => {
    if (!createdId) throw new Error('createdId not set');
    const r = unwrap(await crm.deleteRecord({ object: 'person', id: createdId }));
    expect(r.success).toBe(true);
  });
});

/**
 * link_note_to_record verifies the GraphQL bypass works against a real Twenty.
 * If this passes, the workflow-gate workaround is genuinely effective.
 */
describeIfDestructive('integration: link_note_to_record (GraphQL bypass)', () => {
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
        data: { title: `Eval ${uniq}`, bodyV2: { markdown: 'integration test' } },
      }),
    );
    expect(r.success).toBe(true);
    noteId = r.result.id as string;
  });

  it('links the note to the company via the GraphQL bypass', async () => {
    if (!noteId || !companyId) throw new Error('noteId / companyId not set');
    const r = unwrap(
      await noteTargets.linkNoteToRecord({ noteId, targetCompanyId: companyId }),
    );
    expect(r.success).toBe(true);
    // result is the GraphQL response { createNoteTarget: {...} }
    const noteTarget = (r.result as { createNoteTarget?: any }).createNoteTarget;
    expect(noteTarget?.noteId).toBe(noteId);
    expect(noteTarget?.targetCompanyId).toBe(companyId);
  });

  it('cleanup: delete the company and note', async () => {
    if (companyId) await crm.deleteRecord({ object: 'company', id: companyId });
    if (noteId) await crm.deleteRecord({ object: 'note', id: noteId });
  });
});
