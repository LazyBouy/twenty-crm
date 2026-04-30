import { handleDiscovery } from '../tools/discovery';
import type { TwentyMcpClient, ToolsCallResult } from '../twenty-mcp-client';

const makeClient = (toolsCall: jest.Mock): TwentyMcpClient =>
  ({ toolsCall } as unknown as TwentyMcpClient);

const firstText = (result: ToolsCallResult): string => {
  const block = result.content[0];
  if (block.type !== 'text') throw new Error('expected text');

  return block.text;
};

const wrapped = (catalog: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify({ catalog }) }],
});

describe('handleDiscovery — Twenty {catalog: {...}} wrapper', () => {
  it('unwraps and summarizes when Twenty wraps the categorized map under `catalog`', async () => {
    const toolsCall = jest.fn().mockResolvedValue(
      wrapped({
        ACTION: [{ name: 'send_email', description: 'Send an email' }],
        DASHBOARD: [{ name: 'create_dashboard', description: 'Create a dashboard' }],
      }),
    );
    const result = await handleDiscovery({}, makeClient(toolsCall));
    const text = firstText(result);
    expect(text).toContain('Found 2 tool(s)');
    expect(text).toContain('## ACTION');
    expect(text).toContain('send_email');
    expect(text).toContain('## DASHBOARD');
  });
});
