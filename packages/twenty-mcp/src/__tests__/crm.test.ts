import {
  buildCrmHandlers,
  DEFAULT_INNER_TOOL_NAMES,
  resolveInnerToolNames,
} from '../tools/crm';
import { TwentyMcpClient } from '../twenty-mcp-client';

const makeClient = () => {
  const toolsCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

  return { toolsCall, client: { toolsCall } as unknown as TwentyMcpClient };
};

describe('CRM convenience tools', () => {
  it('searchRecords wraps execute_tool with the search inner name', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildCrmHandlers(client);
    await handlers.searchRecords({ object: 'people', query: 'alice', limit: 5 });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      name: DEFAULT_INNER_TOOL_NAMES.search,
      arguments: { object: 'people', query: 'alice', limit: 5 },
    });
  });

  it('getRecord targets the get inner tool', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildCrmHandlers(client);
    await handlers.getRecord({ object: 'people', id: 'abc' });

    expect(toolsCall.mock.calls[0][1]).toMatchObject({
      name: DEFAULT_INNER_TOOL_NAMES.get,
      arguments: { object: 'people', id: 'abc' },
    });
  });

  it('createRecord, updateRecord, deleteRecord each route to their inner tools', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildCrmHandlers(client);

    await handlers.createRecord({ object: 'companies', data: { name: 'Acme' } });
    await handlers.updateRecord({ object: 'companies', id: 'c1', data: { name: 'Acme 2' } });
    await handlers.deleteRecord({ object: 'companies', id: 'c1' });

    const innerNames = toolsCall.mock.calls.map((c) => (c[1] as { name: string }).name);
    expect(innerNames).toEqual([
      DEFAULT_INNER_TOOL_NAMES.create,
      DEFAULT_INNER_TOOL_NAMES.update,
      DEFAULT_INNER_TOOL_NAMES.delete,
    ]);
  });

  it('respects TWENTY_MCP_INNER_TOOLS overrides', () => {
    const overrides = resolveInnerToolNames({
      TWENTY_MCP_INNER_TOOLS: JSON.stringify({ search: 'crm.search.v2' }),
    } as NodeJS.ProcessEnv);
    expect(overrides.search).toBe('crm.search.v2');
    expect(overrides.get).toBe(DEFAULT_INNER_TOOL_NAMES.get);
  });

  it('falls back to defaults when TWENTY_MCP_INNER_TOOLS is invalid JSON', () => {
    const overrides = resolveInnerToolNames({
      TWENTY_MCP_INNER_TOOLS: 'not-json',
    } as NodeJS.ProcessEnv);
    expect(overrides).toEqual(DEFAULT_INNER_TOOL_NAMES);
  });
});
