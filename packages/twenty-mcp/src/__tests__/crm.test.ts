import { buildCrmHandlers, innerToolName } from '../tools/crm';
import { TwentyMcpClient } from '../twenty-mcp-client';

const makeClient = () => {
  const toolsCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

  return { toolsCall, client: { toolsCall } as unknown as TwentyMcpClient };
};

describe('innerToolName — Twenty per-object tool naming', () => {
  it('search uses find_<plural>', () => {
    expect(innerToolName('search', 'person')).toBe('find_people');
    expect(innerToolName('search', 'people')).toBe('find_people');
    expect(innerToolName('search', 'company')).toBe('find_companies');
    expect(innerToolName('search', 'companies')).toBe('find_companies');
    expect(innerToolName('search', 'opportunity')).toBe('find_opportunities');
  });

  it('get uses find_one_<singular>', () => {
    expect(innerToolName('get', 'people')).toBe('find_one_person');
    expect(innerToolName('get', 'person')).toBe('find_one_person');
    expect(innerToolName('get', 'companies')).toBe('find_one_company');
    expect(innerToolName('get', 'blocklists')).toBe('find_one_blocklist');
  });

  it('create / update / delete use <op>_<singular>', () => {
    expect(innerToolName('create', 'people')).toBe('create_person');
    expect(innerToolName('update', 'companies')).toBe('update_company');
    expect(innerToolName('delete', 'opportunities')).toBe('delete_opportunity');
  });

  it('normalizes spaces and case', () => {
    expect(innerToolName('search', 'Note Targets')).toBe('find_note_targets');
  });
});

/**
 * Wire-level shape tests. These assert what Twenty WOULD ACTUALLY ACCEPT —
 * not what the wrapper happens to forward. The previous mock-based tests
 * validated the wrong thing and let the data-wrapper bug ship.
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
      await handlers.createRecord({ object: 'people', data: { name: 'Alice' } });

      const forwarded = toolsCall.mock.calls[0][1] as { arguments: Record<string, unknown> };
      expect(forwarded.arguments).not.toHaveProperty('object');
      expect(forwarded.arguments).not.toHaveProperty('data');
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
    await handlers.updateRecord({ object: 'companies', id: 'c1', data: { name: 'A2' } });
    await handlers.deleteRecord({ object: 'companies', id: 'c1' });

    const innerNames = toolsCall.mock.calls.map((c) => (c[1] as { toolName: string }).toolName);
    expect(innerNames).toEqual(['create_company', 'update_company', 'delete_company']);
  });
});
