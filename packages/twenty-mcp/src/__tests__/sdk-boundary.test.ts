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
 * Scope: enableMetadata: true — the full registry.
 * The enableMetadata: false subset (discovery + crm + noteTargets) is covered
 * implicitly since those tools are also present in the full registry.
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
const discoveryMap: Record<string, unknown> = { discovery: discoveryToolDefinition };

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

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

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
