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

describe('CRM convenience tools — wire-level', () => {
  it('searchRecords calls execute_tool with find_<plural> and strips object from args', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildCrmHandlers(client);
    await handlers.searchRecords({ object: 'people', query: 'alice', limit: 5 });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'find_people',
      arguments: { query: 'alice', limit: 5 },
    });
  });

  it('getRecord calls execute_tool with find_one_<singular>', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildCrmHandlers(client);
    await handlers.getRecord({ object: 'people', id: 'abc' });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'find_one_person',
      arguments: { id: 'abc' },
    });
  });

  it('createRecord, updateRecord, deleteRecord each route to per-object tools', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildCrmHandlers(client);

    await handlers.createRecord({ object: 'companies', data: { name: 'Acme' } });
    await handlers.updateRecord({ object: 'companies', id: 'c1', data: { name: 'Acme 2' } });
    await handlers.deleteRecord({ object: 'companies', id: 'c1' });

    const innerNames = toolsCall.mock.calls.map((c) => (c[1] as { toolName: string }).toolName);
    expect(innerNames).toEqual(['create_company', 'update_company', 'delete_company']);
  });
});
