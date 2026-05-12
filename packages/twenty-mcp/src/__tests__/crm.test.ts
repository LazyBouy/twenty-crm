import {
  buildCrmHandlers,
  buildToolName,
  resolveObjectNames,
} from '../tools/crm';
import { TwentyMcpClient } from '../twenty-mcp-client';

/**
 * Standard metadata response containing a curated set of objects.
 * The handlers call metadata_query({kind:'objects'}) first to resolve
 * nameSingular/namePlural, then call execute_tool with the inner tool name.
 * Tests must mock toolsCall to return this fixture for the metadata_query call.
 */
const METADATA_OBJECTS = [
  { nameSingular: 'person', namePlural: 'people' },
  { nameSingular: 'company', namePlural: 'companies' },
  { nameSingular: 'opportunity', namePlural: 'opportunities' },
  { nameSingular: 'schemaChangeAudit', namePlural: 'schemaChangeAudits' },
  { nameSingular: 'customerHealth', namePlural: 'customerHealths' },
  { nameSingular: 'companyMetric', namePlural: 'companyMetrics' },
  { nameSingular: 'salesActivity', namePlural: 'salesActivities' },
  // Embedded-acronym names (#12)
  { nameSingular: 'iOSDevice', namePlural: 'iOSDevices' },
  { nameSingular: 'myAPIKey', namePlural: 'myAPIKeys' },
  // Mass-noun name (#13): both singular and plural are the same English mass noun
  { nameSingular: 'companyAnalytics', namePlural: 'companyAnalytics' },
  // Already-snake or space-separated forms that agents might pass
  { nameSingular: 'noteTarget', namePlural: 'noteTargets' },
];

const makeMetadataText = (
  objects: typeof METADATA_OBJECTS = METADATA_OBJECTS,
) => JSON.stringify({ result: objects });

const makeClient = () => {
  const toolsCall = jest
    .fn()
    .mockImplementation((name: string, args: Record<string, unknown>) => {
      // resolveObjectNames calls execute_tool({toolName:'get_object_metadata'}) to fetch
      // the workspace's object list. Return the fixture metadata response for that call.
      if (name === 'execute_tool' && args.toolName === 'get_object_metadata') {
        return Promise.resolve({
          content: [{ type: 'text', text: makeMetadataText() }],
        });
      }
      // Default: echo a success for other execute_tool calls (actual CRUD inner tools)
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

  return { toolsCall, client: { toolsCall } as unknown as TwentyMcpClient };
};

describe('buildToolName — pure name construction (no network)', () => {
  it('search uses find_<snakePlural>', () => {
    expect(buildToolName('search', 'person', 'people')).toBe('find_people');
    expect(buildToolName('search', 'company', 'companies')).toBe(
      'find_companies',
    );
    expect(buildToolName('search', 'opportunity', 'opportunities')).toBe(
      'find_opportunities',
    );
  });

  it('get uses find_one_<snakeSingular>', () => {
    expect(buildToolName('get', 'person', 'people')).toBe('find_one_person');
    expect(buildToolName('get', 'company', 'companies')).toBe(
      'find_one_company',
    );
  });

  it('create / update / delete use <op>_<snakeSingular>', () => {
    expect(buildToolName('create', 'person', 'people')).toBe('create_person');
    expect(buildToolName('update', 'company', 'companies')).toBe(
      'update_company',
    );
    expect(buildToolName('delete', 'opportunity', 'opportunities')).toBe(
      'delete_opportunity',
    );
  });

  // Issue #12: embedded-acronym names use camelToSnakeCase-produced snake forms
  it('handles embedded-acronym snake forms (issue #12)', () => {
    // Server stores nameSingular='iOSDevice', namePlural='iOSDevices'
    // camelToSnakeCase('iOSDevice') → 'i_o_s_device'
    // camelToSnakeCase('iOSDevices') → 'i_o_s_devices'
    expect(buildToolName('search', 'i_o_s_device', 'i_o_s_devices')).toBe(
      'find_i_o_s_devices',
    );
    expect(buildToolName('create', 'i_o_s_device', 'i_o_s_devices')).toBe(
      'create_i_o_s_device',
    );
    expect(buildToolName('get', 'i_o_s_device', 'i_o_s_devices')).toBe(
      'find_one_i_o_s_device',
    );
    expect(buildToolName('update', 'i_o_s_device', 'i_o_s_devices')).toBe(
      'update_i_o_s_device',
    );
    expect(buildToolName('delete', 'i_o_s_device', 'i_o_s_devices')).toBe(
      'delete_i_o_s_device',
    );
  });

  // Issue #13: mass-noun names — singular and plural are the same snake form
  it('handles mass-noun snake forms (issue #13)', () => {
    // Server stores nameSingular='companyAnalytics', namePlural='companyAnalytics'
    // camelToSnakeCase('companyAnalytics') → 'company_analytics'
    expect(
      buildToolName('search', 'company_analytics', 'company_analytics'),
    ).toBe('find_company_analytics');
    expect(
      buildToolName('create', 'company_analytics', 'company_analytics'),
    ).toBe('create_company_analytics');
    expect(buildToolName('get', 'company_analytics', 'company_analytics')).toBe(
      'find_one_company_analytics',
    );
  });

  it('handles multi-word snake forms (issue #11)', () => {
    expect(
      buildToolName('search', 'schema_change_audit', 'schema_change_audits'),
    ).toBe('find_schema_change_audits');
    expect(
      buildToolName('get', 'schema_change_audit', 'schema_change_audits'),
    ).toBe('find_one_schema_change_audit');
    expect(buildToolName('create', 'customer_health', 'customer_healths')).toBe(
      'create_customer_health',
    );
  });
});

describe('resolveObjectNames — resolution logic (mocked metadata)', () => {
  const makeResolveClient = (objects: typeof METADATA_OBJECTS) => {
    const toolsCall = jest
      .fn()
      .mockImplementation((name: string, args: Record<string, unknown>) => {
        if (
          name === 'execute_tool' &&
          args.toolName === 'get_object_metadata'
        ) {
          return Promise.resolve({
            content: [{ type: 'text', text: makeMetadataText(objects) }],
          });
        }
        return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
      });
    return { toolsCall, client: { toolsCall } as unknown as TwentyMcpClient };
  };

  it('resolves nameSingular input exactly', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'person');
    expect(result).toEqual({ nameSingular: 'person', namePlural: 'people' });
  });

  it('resolves namePlural input exactly', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'people');
    expect(result).toEqual({ nameSingular: 'person', namePlural: 'people' });
  });

  it('resolves camelCase nameSingular input (iOSDevice → embedded-acronym object, issue #12)', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'iOSDevice');
    expect(result).toEqual({
      nameSingular: 'iOSDevice',
      namePlural: 'iOSDevices',
    });
  });

  it('resolves camelCase namePlural input (iOSDevices → embedded-acronym object, issue #12)', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'iOSDevices');
    expect(result).toEqual({
      nameSingular: 'iOSDevice',
      namePlural: 'iOSDevices',
    });
  });

  it('resolves snake-cased input for embedded-acronym object (i_o_s_devices)', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'i_o_s_devices');
    expect(result).toEqual({
      nameSingular: 'iOSDevice',
      namePlural: 'iOSDevices',
    });
  });

  it('resolves mass-noun singular (companyAnalytics → mass-noun object, issue #13)', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'companyAnalytics');
    expect(result).toEqual({
      nameSingular: 'companyAnalytics',
      namePlural: 'companyAnalytics',
    });
  });

  it('resolves snake-cased mass-noun form (company_analytics)', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'company_analytics');
    expect(result).toEqual({
      nameSingular: 'companyAnalytics',
      namePlural: 'companyAnalytics',
    });
  });

  it('resolution is case-insensitive', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    const result = await resolveObjectNames(client, 'PERSON');
    expect(result).toEqual({ nameSingular: 'person', namePlural: 'people' });
  });

  it('throws a descriptive "not found" error for unrecognised input', async () => {
    const { client } = makeResolveClient(METADATA_OBJECTS);
    await expect(
      resolveObjectNames(client, 'nonExistentObject'),
    ).rejects.toThrow(/not found in workspace/);
    await expect(
      resolveObjectNames(client, 'nonExistentObject'),
    ).rejects.toThrow(/Available objects:/);
  });

  it('throws an ambiguity error when two objects match the same lowercased form', async () => {
    // Two objects where nameSingular lowercased is identical → input 'testobject'
    // matches both after toLowerCase() comparison.
    const ambiguousObjects = [
      { nameSingular: 'testObject', namePlural: 'testObjects' },
      { nameSingular: 'testobject', namePlural: 'testobjects' },
    ];
    const { client } = makeResolveClient(ambiguousObjects);
    await expect(resolveObjectNames(client, 'testobject')).rejects.toThrow(
      /ambiguous/,
    );
  });
});

/**
 * Wire-level shape tests. These assert what Twenty WOULD ACTUALLY ACCEPT —
 * not what the wrapper happens to forward. The previous mock-based tests
 * validated the wrong thing and let the data-wrapper bug ship.
 *
 * The mock client returns a metadata fixture for metadata_query and echoes
 * success for execute_tool. The assertions are on the execute_tool call shape.
 */
describe('CRM convenience tools — Twenty-shaped payloads', () => {
  describe('searchRecords', () => {
    it('spreads filter to the top level (Twenty find_<plural> expects flat field filters)', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.searchRecords({
        object: 'people',
        filter: { city: { eq: 'Berlin' }, name: { like: '%alice%' } },
        limit: 5,
      });

      // Twenty's find_<plural> schema is `additionalProperties: false` with
      // limit / offset / orderBy / or / and / not / <field-name> at top level.
      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'find_people',
        arguments: {
          limit: 5,
          city: { eq: 'Berlin' },
          name: { like: '%alice%' },
        },
      });
    });

    it('forwards orderBy / offset / or / and / not without re-wrapping', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.searchRecords({
        object: 'companies',
        orderBy: [{ employees: 'DescNullsLast' }],
        offset: 20,
        or: [{ industry: { eq: 'SAAS' } }, { industry: { eq: 'FINTECH' } }],
      });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'find_companies',
        arguments: {
          orderBy: [{ employees: 'DescNullsLast' }],
          offset: 20,
          or: [{ industry: { eq: 'SAAS' } }, { industry: { eq: 'FINTECH' } }],
        },
      });
    });

    it('omits filter entirely when not provided', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.searchRecords({ object: 'people', limit: 3 });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'find_people',
        arguments: { limit: 3 },
      });
    });

    // Issue #12: embedded-acronym object name routes to the correct inner tool
    it('routes embedded-acronym object (iOSDevices) to find_i_o_s_devices, NOT find_iosdevices', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.searchRecords({ object: 'iOSDevices', limit: 5 });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'find_i_o_s_devices',
        arguments: { limit: 5 },
      });
    });

    // Issue #13: mass-noun object name routes to the correct inner tool
    it('routes mass-noun object (companyAnalytics) to find_company_analytics', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.searchRecords({ object: 'companyAnalytics', limit: 5 });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'find_company_analytics',
        arguments: { limit: 5 },
      });
    });
  });

  describe('getRecord', () => {
    it('forwards only {id} (Twenty find_one expects exactly that)', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.getRecord({ object: 'people', id: 'abc-123' });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'find_one_person',
        arguments: { id: 'abc-123' },
      });
    });
  });

  describe('createRecord', () => {
    it('passes data fields at the TOP LEVEL (no `data` wrapper) — this was the 1.1M-token bug', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.createRecord({
        object: 'companies',
        data: { name: 'Acme', employees: 42, city: 'Berlin' },
      });

      // Twenty's create_<singular> is `additionalProperties: false` — sending
      // `{data: {...}}` was rejected with "Object company doesn't have any 'data' field".
      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'create_company',
        arguments: { name: 'Acme', employees: 42, city: 'Berlin' },
      });
    });

    it('does NOT include the `object` arg in the forwarded payload', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.createRecord({
        object: 'people',
        data: { name: 'Alice' },
      });

      const forwarded = toolsCall.mock.calls.find(
        (c: [string, unknown]) => c[0] === 'execute_tool',
      ) as [string, { arguments: Record<string, unknown> }] | undefined;
      expect(forwarded).toBeDefined();
      expect(forwarded![1].arguments).not.toHaveProperty('object');
      expect(forwarded![1].arguments).not.toHaveProperty('data');
    });

    // Issue #13: mass-noun create routes to create_company_analytics (NOT create_company_analytic)
    it('routes mass-noun create to create_company_analytics, NOT create_company_analytic (issue #13)', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.createRecord({
        object: 'companyAnalytics',
        data: { name: 'Q1 Analytics' },
      });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'create_company_analytics',
        arguments: { name: 'Q1 Analytics' },
      });
    });

    // Issue #12: embedded-acronym create routes to the correct inner tool
    it('routes embedded-acronym create (myAPIKeys) to create_my_a_p_i_key (issue #12)', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.createRecord({
        object: 'myAPIKeys',
        data: { name: 'test-key' },
      });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'create_my_a_p_i_key',
        arguments: { name: 'test-key' },
      });
    });
  });

  describe('updateRecord', () => {
    it('sends {id, ...data} flat — same `additionalProperties: false` constraint', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.updateRecord({
        object: 'companies',
        id: 'c-1',
        data: { name: 'Acme 2', employees: 99 },
      });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'update_company',
        arguments: { id: 'c-1', name: 'Acme 2', employees: 99 },
      });
    });
  });

  describe('deleteRecord', () => {
    it('forwards only {id}', async () => {
      const { toolsCall, client } = makeClient();
      const handlers = buildCrmHandlers(client);
      await handlers.deleteRecord({ object: 'opportunities', id: 'o-1' });

      expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
        toolName: 'delete_opportunity',
        arguments: { id: 'o-1' },
      });
    });
  });

  it('routes create/update/delete to per-object inner tools by name', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildCrmHandlers(client);
    await handlers.createRecord({ object: 'companies', data: { name: 'A' } });
    await handlers.updateRecord({
      object: 'companies',
      id: 'c1',
      data: { name: 'A2' },
    });
    await handlers.deleteRecord({ object: 'companies', id: 'c1' });

    // Filter out the get_object_metadata calls (used internally by resolveObjectNames)
    // and keep only the CRUD inner tool names.
    const innerNames = toolsCall.mock.calls
      .filter(
        (c: [string, { toolName?: string }]) =>
          c[0] === 'execute_tool' && c[1].toolName !== 'get_object_metadata',
      )
      .map((c: [string, { toolName: string }]) => c[1].toolName);
    expect(innerNames).toEqual([
      'create_company',
      'update_company',
      'delete_company',
    ]);
  });
});
