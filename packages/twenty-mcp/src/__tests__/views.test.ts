import { buildViewHandlers, viewsDispatchEntries } from '../tools/views';
import { TwentyMcpClient } from '../twenty-mcp-client';

const makeClient = () => {
  const toolsCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const graphqlMutation = jest.fn();

  return {
    toolsCall,
    graphqlMutation,
    client: { toolsCall, graphqlMutation } as unknown as TwentyMcpClient,
  };
};

describe('views — wire-level routing', () => {
  it.each([
    ['metadataCreateView', 'create_view'],
    ['metadataUpdateView', 'update_view'],
    ['metadataCreateViewField', 'create_view_field'],
    ['metadataUpdateViewField', 'update_view_field'],
    ['metadataCreateManyViewFields', 'create_many_view_fields'],
    ['metadataCreateViewFilter', 'create_view_filter'],
    ['metadataUpdateViewFilter', 'update_view_filter'],
    ['metadataCreateViewSort', 'create_view_sort'],
  ] as const)('%s routes to %s', async (handlerName, innerTool) => {
    const { toolsCall, client } = makeClient();
    const handlers = buildViewHandlers(client);
    // Use minimal valid args; types are loose in tests since the proxy passes through.
    await (handlers[handlerName] as (a: unknown) => Promise<unknown>)({
      id: '00000000-0000-0000-0000-000000000001',
      viewId: '00000000-0000-0000-0000-000000000002',
      fieldMetadataId: '00000000-0000-0000-0000-000000000003',
      name: 'x',
      objectNameSingular: 'company',
      visibility: 'WORKSPACE',
      operand: 'IS',
      value: 'TIER_A',
      viewFields: [
        {
          viewId: '00000000-0000-0000-0000-000000000002',
          fieldMetadataId: '00000000-0000-0000-0000-000000000003',
        },
      ],
    });

    expect(toolsCall).toHaveBeenCalledWith(
      'execute_tool',
      expect.objectContaining({ toolName: innerTool }),
    );
  });

  it('dispatch entries cover the 7 plan op kinds for views', () => {
    expect(Object.keys(viewsDispatchEntries).sort()).toEqual([
      'CREATE_VIEW',
      'CREATE_VIEW_FIELD',
      'CREATE_VIEW_FILTER',
      'CREATE_VIEW_SORT',
      'UPDATE_VIEW',
      'UPDATE_VIEW_FIELD',
      'UPDATE_VIEW_FILTER',
    ]);
  });

  it('all view dispatch entries use inner_tool transport', () => {
    for (const [op, entry] of Object.entries(viewsDispatchEntries)) {
      expect(entry.transport).toBe('inner_tool');
      expect((entry as { innerToolName: string }).innerToolName).toMatch(/^(create|update)_view/);
      expect(op).toMatch(/^(CREATE|UPDATE)_VIEW/);
    }
  });
});
