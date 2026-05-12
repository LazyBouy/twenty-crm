/**
 * SDK boundary test — asserts that the MCP SDK's `tools/list` response
 * equals the union of all `*ToolDefinitions` map keys (+ the discovery
 * singleton). This is the mechanical verifier that catches:
 *   - defined-but-not-registered: a key present in a definition map but
 *     absent from `server.registerTool(...)` in server.ts
 *   - stray-registration: a `registerTool(...)` call whose name has no
 *     corresponding key in any definition map
 *   - name-drift: a `registerTool(...)` call whose first argument differs
 *     from the definition map key
 *
 * SDK version: @modelcontextprotocol/sdk ^1.18.0
 * Transport: InMemoryTransport.createLinkedPair() — portable over protocol
 * message path; does not depend on internal SDK APIs.
 *
 * Parametrised over both enableMetadata values (true and false) so that any
 * accidental migration of a metadata tool across the feature-flag boundary is
 * caught immediately — the false-case asserts a hard 7-tool contract.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../server';
import { accessToolDefinitions } from '../tools/access';
import { crmToolDefinitions } from '../tools/crm';
import { discoveryToolDefinition } from '../tools/discovery';
import { metadataToolDefinitions } from '../tools/metadata';
import { noteTargetToolDefinitions } from '../tools/note-targets';
import { viewToolDefinitions } from '../tools/views';
import { workflowToolDefinitions } from '../tools/workflows';

// discovery is a singleton object, not a Record<string, …>; wrap it so it
// can be treated uniformly alongside the other maps.
// discovery is a singleton, not a map entry.
const discoveryMap: Record<string, unknown> = {
  discovery: discoveryToolDefinition,
};

/** All definition map keys in the enableMetadata: true universe. */
const expectedKeys = new Set<string>([
  ...Object.keys(discoveryMap),
  ...Object.keys(crmToolDefinitions),
  ...Object.keys(noteTargetToolDefinitions),
  ...Object.keys(metadataToolDefinitions),
  ...Object.keys(viewToolDefinitions),
  ...Object.keys(accessToolDefinitions),
  ...Object.keys(workflowToolDefinitions),
]);

/**
 * Hard contract for enableMetadata: false — exactly these 7 tools, no more, no fewer.
 * If a metadata tool is accidentally moved outside the if (enableMetadata) guard in
 * server.ts, this assertion will catch it.
 */
const BASELINE_TOOLS = new Set<string>([
  'discovery',
  'search_records',
  'get_record',
  'create_record',
  'update_record',
  'delete_record',
  'link_note_to_record',
]);

describe('sdk-boundary: tools/list vs definition maps (enableMetadata: true)', () => {
  let registeredNames: Set<string>;

  beforeAll(async () => {
    // Boot server with no real API calls — registerTool is synchronous and
    // no handler is invoked during registration.
    const server = createServer({
      twentyBaseUrl: 'http://localhost:4440',
      twentyApiKey: 'test',
      enableMetadata: true,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'sdk-boundary-test', version: '0.0.0' });

    // Connect both ends concurrently. Sequential awaits also work (InMemoryTransport.start()
    // does not block on traffic), but Promise.all is idiomatic for in-process MCP setups.
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    registeredNames = new Set(tools.map((t) => t.name));

    await client.close();
  });

  it('every definition key is registered (no defined-but-not-registered tools)', () => {
    const missing: string[] = [];
    for (const key of expectedKeys) {
      if (!registeredNames.has(key)) {
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every registered name has a definition key (no stray registrations)', () => {
    const stray: string[] = [];
    for (const name of registeredNames) {
      if (!expectedKeys.has(name)) {
        stray.push(name);
      }
    }
    expect(stray).toEqual([]);
  });
});

describe('sdk-boundary: tools/list vs baseline contract (enableMetadata: false)', () => {
  let registeredNames: Set<string>;

  beforeAll(async () => {
    // Boot server with enableMetadata: false — only the 7 baseline tools should appear.
    // Any metadata tool accidentally moved outside the if (enableMetadata) guard in
    // server.ts will cause both assertions below to fail.
    const server = createServer({
      twentyBaseUrl: 'http://localhost:4440',
      twentyApiKey: 'test',
      enableMetadata: false,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client({
      name: 'sdk-boundary-false-test',
      version: '0.0.0',
    });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    registeredNames = new Set(tools.map((t) => t.name));

    await client.close();
  });

  it('exactly the 7 baseline tools are registered (no metadata tool leaked into default registry)', () => {
    // Hard contract: these 7 tools and no others.
    const unexpected: string[] = [];
    for (const name of registeredNames) {
      if (!BASELINE_TOOLS.has(name)) {
        unexpected.push(name);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('all 7 baseline tools are present (none accidentally removed)', () => {
    const missing: string[] = [];
    for (const name of BASELINE_TOOLS) {
      if (!registeredNames.has(name)) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('total registered count is exactly 7', () => {
    expect(registeredNames.size).toBe(7);
  });
});
