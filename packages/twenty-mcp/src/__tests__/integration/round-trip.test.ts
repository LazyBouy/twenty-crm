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
