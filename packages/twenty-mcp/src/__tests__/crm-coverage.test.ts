import { resolveObjectNames } from '../tools/crm';
import { TwentyMcpClient } from '../twenty-mcp-client';

/**
 * crm-coverage: resolution-logic drift gate.
 *
 * After the issue #12/#13 fix, the name-construction path IS camelToSnakeCase
 * applied to server-stored nameSingular/namePlural — there is no separate regex
 * to verify against the server algorithm. This file therefore pivots to testing
 * the resolveObjectNames() resolution logic against a mocked metadata response.
 *
 * The drift gate is now: "given an input form that an agent might supply, does
 * resolveObjectNames return the correct {nameSingular, namePlural} from the
 * metadata fixture?" If resolution logic regresses, these tests catch it before
 * any tool routing diverges from the server.
 */

// Representative workspace object list — mirrors the kinds of objects a real
// Twenty workspace would expose, including embedded-acronym and mass-noun stems.
const FIXTURE_OBJECTS = [
  { nameSingular: 'person', namePlural: 'people' },
  { nameSingular: 'company', namePlural: 'companies' },
  { nameSingular: 'opportunity', namePlural: 'opportunities' },
  { nameSingular: 'schemaChangeAudit', namePlural: 'schemaChangeAudits' },
  { nameSingular: 'customerHealth', namePlural: 'customerHealths' },
  { nameSingular: 'companyMetric', namePlural: 'companyMetrics' },
  { nameSingular: 'salesActivity', namePlural: 'salesActivities' },
  { nameSingular: 'productCategory', namePlural: 'productCategories' },
  { nameSingular: 'noteTarget', namePlural: 'noteTargets' },
  { nameSingular: 'workflowVersion', namePlural: 'workflowVersions' },
  // Embedded-acronym names — issue #12
  { nameSingular: 'iOSDevice', namePlural: 'iOSDevices' },
  { nameSingular: 'myAPIKey', namePlural: 'myAPIKeys' },
  { nameSingular: 'userIPAddress', namePlural: 'userIPAddresses' },
  // Mass-noun names — issue #13
  { nameSingular: 'companyAnalytics', namePlural: 'companyAnalytics' },
  { nameSingular: 'salesData', namePlural: 'salesData' },
  { nameSingular: 'productMetadata', namePlural: 'productMetadata' },
];

type ObjectMetadataItem = { nameSingular: string; namePlural: string };

const makeClient = (objects: ObjectMetadataItem[] = FIXTURE_OBJECTS) => {
  const toolsCall = jest
    .fn()
    .mockImplementation((name: string, args: Record<string, unknown>) => {
      // resolveObjectNames calls execute_tool({toolName:'get_object_metadata'}) to fetch
      // the workspace's object list.
      if (name === 'execute_tool' && args.toolName === 'get_object_metadata') {
        return Promise.resolve({
          content: [
            { type: 'text', text: JSON.stringify({ result: objects }) },
          ],
        });
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    });
  return { toolsCall, client: { toolsCall } as unknown as TwentyMcpClient };
};

describe('crm-coverage: resolveObjectNames resolution logic', () => {
  // --- Standard objects ---

  it("'person' (nameSingular) resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'person')).toEqual({
      nameSingular: 'person',
      namePlural: 'people',
    });
  });

  it("'people' (namePlural) resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'people')).toEqual({
      nameSingular: 'person',
      namePlural: 'people',
    });
  });

  it("'company' (nameSingular) resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'company')).toEqual({
      nameSingular: 'company',
      namePlural: 'companies',
    });
  });

  it("'companies' (namePlural) resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'companies')).toEqual({
      nameSingular: 'company',
      namePlural: 'companies',
    });
  });

  // --- Multi-word camelCase (issue #11 regression) ---

  it("'schemaChangeAudit' resolves to {nameSingular:'schemaChangeAudit', namePlural:'schemaChangeAudits'}", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'schemaChangeAudit')).toEqual({
      nameSingular: 'schemaChangeAudit',
      namePlural: 'schemaChangeAudits',
    });
  });

  it("'schemaChangeAudits' (plural form) resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'schemaChangeAudits')).toEqual({
      nameSingular: 'schemaChangeAudit',
      namePlural: 'schemaChangeAudits',
    });
  });

  it("snake-cased 'schema_change_audit' resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'schema_change_audit')).toEqual({
      nameSingular: 'schemaChangeAudit',
      namePlural: 'schemaChangeAudits',
    });
  });

  it("snake-cased plural 'schema_change_audits' resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'schema_change_audits')).toEqual({
      nameSingular: 'schemaChangeAudit',
      namePlural: 'schemaChangeAudits',
    });
  });

  // --- Embedded-acronym names (issue #12) ---

  it("'iOSDevice' (camelCase nameSingular) resolves to embedded-acronym object", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'iOSDevice')).toEqual({
      nameSingular: 'iOSDevice',
      namePlural: 'iOSDevices',
    });
  });

  it("'iOSDevices' (camelCase namePlural) resolves to embedded-acronym object", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'iOSDevices')).toEqual({
      nameSingular: 'iOSDevice',
      namePlural: 'iOSDevices',
    });
  });

  it("snake-cased 'i_o_s_device' resolves to embedded-acronym object", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'i_o_s_device')).toEqual({
      nameSingular: 'iOSDevice',
      namePlural: 'iOSDevices',
    });
  });

  it("snake-cased plural 'i_o_s_devices' resolves to embedded-acronym object", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'i_o_s_devices')).toEqual({
      nameSingular: 'iOSDevice',
      namePlural: 'iOSDevices',
    });
  });

  it("'myAPIKey' resolves to {nameSingular:'myAPIKey', namePlural:'myAPIKeys'}", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'myAPIKey')).toEqual({
      nameSingular: 'myAPIKey',
      namePlural: 'myAPIKeys',
    });
  });

  it("'myAPIKeys' (plural) resolves correctly", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'myAPIKeys')).toEqual({
      nameSingular: 'myAPIKey',
      namePlural: 'myAPIKeys',
    });
  });

  it("snake-cased 'my_a_p_i_key' resolves to embedded-acronym object", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'my_a_p_i_key')).toEqual({
      nameSingular: 'myAPIKey',
      namePlural: 'myAPIKeys',
    });
  });

  // --- Mass-noun names (issue #13) ---

  it("'companyAnalytics' resolves to {nameSingular:'companyAnalytics', namePlural:'companyAnalytics'}", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'companyAnalytics')).toEqual({
      nameSingular: 'companyAnalytics',
      namePlural: 'companyAnalytics',
    });
  });

  it("snake-cased 'company_analytics' resolves to mass-noun object", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'company_analytics')).toEqual({
      nameSingular: 'companyAnalytics',
      namePlural: 'companyAnalytics',
    });
  });

  it("'salesData' resolves correctly (mass noun)", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'salesData')).toEqual({
      nameSingular: 'salesData',
      namePlural: 'salesData',
    });
  });

  it("'productMetadata' resolves correctly (mass noun)", async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'productMetadata')).toEqual({
      nameSingular: 'productMetadata',
      namePlural: 'productMetadata',
    });
  });

  // --- Case-insensitive matching ---

  it('resolution is case-insensitive (PERSON → person)', async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'PERSON')).toEqual({
      nameSingular: 'person',
      namePlural: 'people',
    });
  });

  it('resolution is case-insensitive (COMPANIES → company)', async () => {
    const { client } = makeClient();
    expect(await resolveObjectNames(client, 'COMPANIES')).toEqual({
      nameSingular: 'company',
      namePlural: 'companies',
    });
  });

  // --- Error cases ---

  it('throws "not found in workspace" for unrecognised input', async () => {
    const { client } = makeClient();
    await expect(
      resolveObjectNames(client, 'nonExistentObject'),
    ).rejects.toThrow(/not found in workspace/);
  });

  it('error message includes available object names', async () => {
    const { client } = makeClient();
    await expect(resolveObjectNames(client, 'bogus')).rejects.toThrow(
      /Available objects:/,
    );
  });

  it('throws ambiguity error when two objects match the same lowercased form', async () => {
    // Two objects where nameSingular lowercased is identical.
    // 'testobject' matches nameSingular.toLowerCase() of both → ambiguous.
    const ambiguous = [
      { nameSingular: 'testObject', namePlural: 'testObjects' },
      { nameSingular: 'testobject', namePlural: 'testobjects' },
    ];
    const { client } = makeClient(ambiguous);
    await expect(resolveObjectNames(client, 'testobject')).rejects.toThrow(
      /ambiguous/,
    );
  });

  it('wraps metadata fetch errors with a descriptive message', async () => {
    const toolsCall = jest
      .fn()
      .mockRejectedValue(new Error('connection refused'));
    const client = { toolsCall } as unknown as TwentyMcpClient;
    await expect(resolveObjectNames(client, 'person')).rejects.toThrow(
      /Failed to fetch object metadata/,
    );
  });
});
