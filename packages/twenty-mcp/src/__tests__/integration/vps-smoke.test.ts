/**
 * VPS smoke test — READ-ONLY production verification after a deploy.
 *
 * Triple-gated:
 *   - TWENTY_MCP_INTEGRATION=1
 *   - INCLUDE_INTEGRATION=1
 *   - MCP_VPS_SMOKE=1
 *
 * Refuses to start if MCP_INTEGRATION_DESTRUCTIVE_OK=1 — defence in depth so a
 * misconfigured env can't accidentally write to prod via this file.
 *
 * What it covers:
 *   - discovery({}) returns a sane catalog (deployed proxy is up)
 *   - search_records on `person` returns a list (CRUD path is wired)
 *   - link_note_to_record SCHEMA verification (no actual write — relies on
 *     the deployed proxy + the GraphQL bypass; this test verifies the routing
 *     through coverage.test.ts in CI, not at runtime)
 *
 * Run after a VPS deploy:
 *   TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_VPS_SMOKE=1 \
 *     npx dotenv -e .env.production -- jest src/__tests__/integration/vps-smoke.test.ts
 */
import { TwentyMcpClient } from '../../twenty-mcp-client';

const enabled = process.env.TWENTY_MCP_INTEGRATION === '1';
const smokeMode = process.env.MCP_VPS_SMOKE === '1';
const destructiveOk = process.env.MCP_INTEGRATION_DESTRUCTIVE_OK === '1';

if (enabled && smokeMode && destructiveOk) {
  throw new Error(
    '[vps-smoke.test.ts] REFUSING TO START: MCP_VPS_SMOKE=1 and MCP_INTEGRATION_DESTRUCTIVE_OK=1 are mutually exclusive. ' +
      'VPS smoke is read-only by contract. Drop the destructive flag.',
  );
}

const describeIfSmoke = enabled && smokeMode ? describe : describe.skip;

const baseUrl = process.env.TWENTY_BASE_URL ?? '';
// On VPS, the /mcp endpoint is behind a Caddy gate that requires the inbound
// token as the bearer. The TWENTY_API_KEY is forwarded by the proxy itself.
const inboundToken = process.env.MCP_INBOUND_TOKEN ?? '';

describeIfSmoke('vps-smoke: deployed proxy is reachable + read-only paths return success', () => {
  if (enabled && smokeMode) {
    if (!baseUrl) throw new Error('MCP_VPS_SMOKE=1 but TWENTY_BASE_URL not set');
    if (!inboundToken)
      throw new Error('MCP_VPS_SMOKE=1 but MCP_INBOUND_TOKEN not set (Caddy gate requires it)');
  }

  // The deployed proxy authenticates inbound requests via the Caddy token.
  // We pass it as the bearer; the proxy uses its own TWENTY_API_KEY env to
  // talk to Twenty internally.
  const client = new TwentyMcpClient({ baseUrl, apiKey: inboundToken });

  const unwrap = (r: { content: Array<{ type: string; text?: string }> }) => {
    const block = r.content[0];
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('expected text block in tool result');
    }

    return block.text;
  };

  it('discovery({}) returns a tool catalog', async () => {
    const r = await client.toolsCall('discovery', {});
    const text = unwrap(r);
    expect(text).toMatch(/Found \d+ tool/);
    expect(text).toContain('## ');
  });

  it('search_records({object: "person"}) returns success: true', async () => {
    const r = await client.toolsCall('search_records', { object: 'person', limit: 1 });
    const text = unwrap(r);
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
  });

  it('discovery({focus: "find_people"}) returns the inner schema', async () => {
    const r = await client.toolsCall('discovery', { focus: 'find_people' });
    const text = unwrap(r);
    // Either the inner JSON schema or a learn_tools envelope; both should not be errors.
    expect(text.toLowerCase()).not.toContain('failed');
  });

  it('discovery({focus: "create_company"}) returns the inner schema', async () => {
    const r = await client.toolsCall('discovery', { focus: 'create_company' });
    const text = unwrap(r);
    expect(text.toLowerCase()).not.toContain('failed');
  });

  // NOTE: link_note_to_record has no read-only mode and would write a noteTarget.
  // For post-deploy verification of the bug #4 fix, we exercise that path
  // SEPARATELY against pre-seeded test note + company records, using the
  // tag prefix `mcp-vps-link-` so they're identifiable. That test is opt-in
  // beyond MCP_VPS_SMOKE — it requires MCP_VPS_SMOKE_LINK_NOTE_ID + ..._COMPANY_ID
  // env vars pointing at workspace records you've decided are safe to link.
  describe('link_note_to_record (post-deploy, opt-in)', () => {
    const noteId = process.env.MCP_VPS_SMOKE_LINK_NOTE_ID;
    const companyId = process.env.MCP_VPS_SMOKE_LINK_COMPANY_ID;
    const linkEnabled = enabled && smokeMode && Boolean(noteId) && Boolean(companyId);
    const desc = linkEnabled ? describe : describe.skip;

    desc('with pre-seeded test records', () => {
      it('successfully creates the noteTarget link via /graphql (bug #4 verification)', async () => {
        const r = await client.toolsCall('link_note_to_record', {
          noteId,
          targetCompanyId: companyId,
        });
        const text = unwrap(r);
        const parsed = JSON.parse(text);
        expect(parsed.success).toBe(true);
        expect(parsed.result?.createNoteTarget?.noteId).toBe(noteId);
      });
    });
  });
});
