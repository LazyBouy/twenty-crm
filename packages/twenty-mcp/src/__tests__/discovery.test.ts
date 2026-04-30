import type { ToolsCallResult } from '../twenty-mcp-client';
import { handleDiscovery } from '../tools/discovery';
import { TwentyMcpClient } from '../twenty-mcp-client';

const makeClient = (toolsCall: jest.Mock): TwentyMcpClient =>
  ({ toolsCall } as unknown as TwentyMcpClient);

const catalogText = (catalog: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(catalog) }],
});

const firstText = (result: ToolsCallResult): string => {
  const block = result.content[0];
  if (block.type !== 'text') throw new Error(`expected text block, got ${block.type}`);

  return block.text;
};

describe('handleDiscovery', () => {
  it('with no args calls get_tool_catalog and summarizes by category', async () => {
    const toolsCall = jest.fn().mockResolvedValue(
      catalogText({
        records: [
          { name: 'search_records', description: 'Search records' },
          { name: 'get_record', description: 'Get a record' },
        ],
        actions: [{ name: 'send_email', description: 'Send email' }],
      }),
    );
    const result = await handleDiscovery({}, makeClient(toolsCall));

    expect(toolsCall).toHaveBeenCalledWith('get_tool_catalog', {});
    const text = firstText(result);
    expect(text).toContain('Found 3 tool(s)');
    expect(text).toContain('## records');
    expect(text).toContain('search_records');
    expect(text).toContain('## actions');
  });

  it('with focus calls learn_tools with the selected name', async () => {
    const schemaResult = { content: [{ type: 'text', text: '{"schema":{"type":"object"}}' }] };
    const toolsCall = jest.fn().mockResolvedValue(schemaResult);
    const result = await handleDiscovery({ focus: 'search_records' }, makeClient(toolsCall));

    expect(toolsCall).toHaveBeenCalledWith('learn_tools', { tools: ['search_records'] });
    expect(result).toBe(schemaResult);
  });

  it('with query post-filters the catalog by substring', async () => {
    const toolsCall = jest.fn().mockResolvedValue(
      catalogText([
        { name: 'search_records', description: 'records', category: 'records' },
        { name: 'send_email', description: 'email', category: 'actions' },
      ]),
    );
    const result = await handleDiscovery({ query: 'email' }, makeClient(toolsCall));

    const text = firstText(result);
    expect(text).toContain('send_email');
    expect(text).not.toContain('search_records');
  });

  it('with category passes it through to get_tool_catalog', async () => {
    const toolsCall = jest.fn().mockResolvedValue(catalogText([]));
    await handleDiscovery({ category: 'records' }, makeClient(toolsCall));

    expect(toolsCall).toHaveBeenCalledWith('get_tool_catalog', { category: 'records' });
  });

  it('surfaces upstream errors as isError content blocks', async () => {
    const toolsCall = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await handleDiscovery({ focus: 'unknown' }, makeClient(toolsCall));

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain('learn_tools failed');
    expect(text).toContain('boom');
  });

  it('keeps output under 4 KB even with a moderately large catalog', async () => {
    const big = {
      records: Array.from({ length: 30 }, (_, i) => ({
        name: `tool_${i}`,
        description: 'a fairly verbose description that runs on a bit',
      })),
    };
    const toolsCall = jest.fn().mockResolvedValue(catalogText(big));
    const result = await handleDiscovery({}, makeClient(toolsCall));
    const text = firstText(result);
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('and 22 more');
  });
});
