/**
 * Live-fire integration test — gated behind `TWENTY_MCP_INTEGRATION=1`.
 *
 * Skipped by default so unit-test runs stay fast and offline. When enabled,
 * exercises the full create → search → get → update → delete lifecycle
 * against a running Twenty (the docker-compose stack at
 * `${TWENTY_BASE_URL:-http://localhost:4440}/mcp`).
 *
 * This is the safety net for "the schema fixture matches reality" — if the
 * wrapper produces a payload Twenty actually rejects, this test fails loudly.
 *
 * Run:
 *   TWENTY_MCP_INTEGRATION=1 \
 *   TWENTY_BASE_URL=http://localhost:4440 \
 *   TWENTY_API_KEY=<key> \
 *   npx jest src/__tests__/integration --testTimeout 30000
 */
import { buildCrmHandlers } from '../../tools/crm';
import { buildNoteTargetHandlers } from '../../tools/note-targets';
import { TwentyMcpClient, type ToolsCallResult } from '../../twenty-mcp-client';

const enabled = process.env.TWENTY_MCP_INTEGRATION === '1';
const describeIfEnabled = enabled ? describe : describe.skip;

const baseUrl = process.env.TWENTY_BASE_URL ?? 'http://localhost:4440';
const apiKey = process.env.TWENTY_API_KEY ?? '';

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

describeIfEnabled('integration: people CRUD round-trip', () => {
  if (enabled && !apiKey) {
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
    expect(r.result?.id).toBe(createdId);
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
    expect(r.result?.jobTitle).toBe('Audit Subject');
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
describeIfEnabled('integration: link_note_to_record (GraphQL bypass)', () => {
  if (enabled && !apiKey) {
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
    // result is the GraphQL response { createOneNoteTarget: {...} }
    const noteTarget = (r.result as { createOneNoteTarget?: any }).createOneNoteTarget;
    expect(noteTarget?.noteId).toBe(noteId);
    expect(noteTarget?.targetCompanyId).toBe(companyId);
  });

  it('cleanup: delete the company and note', async () => {
    if (companyId) await crm.deleteRecord({ object: 'company', id: companyId });
    if (noteId) await crm.deleteRecord({ object: 'note', id: noteId });
  });
});
