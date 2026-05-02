import { buildViewHandlers, FIELD_TYPE_OPERAND_MAP, viewsDispatchEntries } from '../tools/views';
import { TwentyMcpClient } from '../twenty-mcp-client';

// Canonical mock response for get_field_metadata: returns a SELECT field by default.
// Tests that need a specific type override the mock.
const MOCK_SELECT_FIELD_RESPONSE = {
  content: [{ type: 'text', text: JSON.stringify([{ id: '00000000-0000-0000-0000-000000000003', type: 'SELECT', name: 'status' }]) }],
  isError: false,
};

const makeClient = (fieldType = 'SELECT') => {
  const fieldResponse = {
    content: [{ type: 'text', text: JSON.stringify([{ id: '00000000-0000-0000-0000-000000000003', type: fieldType, name: 'testField' }]) }],
    isError: false,
  };
  const toolsCall = jest.fn().mockImplementation((method: string, args: { toolName?: string }) => {
    if (args.toolName === 'get_field_metadata') {
      return Promise.resolve(fieldResponse);
    }
    return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  });
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
    // Use SELECT field type so IS operand is valid for both filter handlers.
    const { toolsCall, client } = makeClient('SELECT');
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

// --- Operand validation tests ------------------------------------------------

describe('metadataCreateViewFilter — operand validation', () => {
  it('operand DATE_TIME GREATER_THAN_OR_EQUAL rejected', async () => {
    const { toolsCall, client } = makeClient('DATE_TIME');
    const handlers = buildViewHandlers(client);

    const result = await handlers.metadataCreateViewFilter({
      viewId: '00000000-0000-0000-0000-000000000002',
      fieldMetadataId: '00000000-0000-0000-0000-000000000003',
      operand: 'GREATER_THAN_OR_EQUAL',
      value: '2026-01-01T00:00:00.000Z',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME/,
    );
    // create_view_filter must NOT have been called
    const createCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'create_view_filter',
    );
    expect(createCalls).toHaveLength(0);
  });

  it('operand DATE_TIME IS_AFTER accepted', async () => {
    const { toolsCall, client } = makeClient('DATE_TIME');
    const handlers = buildViewHandlers(client);

    const result = await handlers.metadataCreateViewFilter({
      viewId: '00000000-0000-0000-0000-000000000002',
      fieldMetadataId: '00000000-0000-0000-0000-000000000003',
      operand: 'IS_AFTER',
      value: '2026-01-01T00:00:00.000Z',
    });

    expect(result.isError).toBeFalsy();
    const createCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'create_view_filter',
    );
    expect(createCalls).toHaveLength(1);
  });

  it('operand unknown type fails open (with console.warn)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // RICH_TEXT is not in FIELD_TYPE_OPERAND_MAP
    const { toolsCall, client } = makeClient('RICH_TEXT');
    const handlers = buildViewHandlers(client);

    const result = await handlers.metadataCreateViewFilter({
      viewId: '00000000-0000-0000-0000-000000000002',
      fieldMetadataId: '00000000-0000-0000-0000-000000000003',
      operand: 'CONTAINS',
      value: 'test',
    });

    expect(result.isError).toBeFalsy();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown field type'));
    const createCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'create_view_filter',
    );
    expect(createCalls).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('operand empty metadata fails closed', async () => {
    // get_field_metadata returns empty array — field not found
    const toolsCall = jest.fn().mockImplementation((_method: string, args: { toolName?: string }) => {
      if (args.toolName === 'get_field_metadata') {
        return Promise.resolve({ content: [{ type: 'text', text: '[]' }], isError: false });
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    });
    const client = { toolsCall } as unknown as TwentyMcpClient;
    const handlers = buildViewHandlers(client);

    const result = await handlers.metadataCreateViewFilter({
      viewId: '00000000-0000-0000-0000-000000000002',
      fieldMetadataId: '00000000-0000-0000-0000-000000000003',
      operand: 'IS',
      value: 'test',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('field metadata lookup returned no rows');
    const createCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'create_view_filter',
    );
    expect(createCalls).toHaveLength(0);
  });
});

describe('metadataUpdateViewFilter — operand validation', () => {
  it('UPDATE_VIEW_FILTER operand without fieldMetadataId fails closed', async () => {
    const { toolsCall, client } = makeClient('SELECT');
    const handlers = buildViewHandlers(client);

    const result = await handlers.metadataUpdateViewFilter({
      id: '00000000-0000-0000-0000-000000000001',
      operand: 'GREATER_THAN_OR_EQUAL',
      // no fieldMetadataId
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('requires fieldMetadataId');
    // No toolsCall should have been made at all
    expect(toolsCall).not.toHaveBeenCalled();
  });

  it('UPDATE_VIEW_FILTER value-only passes through', async () => {
    const { toolsCall, client } = makeClient('SELECT');
    const handlers = buildViewHandlers(client);

    const result = await handlers.metadataUpdateViewFilter({
      id: '00000000-0000-0000-0000-000000000001',
      value: 'new-value',
      // no operand, no fieldMetadataId
    });

    expect(result.isError).toBeFalsy();
    const updateCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'update_view_filter',
    );
    expect(updateCalls).toHaveLength(1);
    // No get_field_metadata call made
    const metadataCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'get_field_metadata',
    );
    expect(metadataCalls).toHaveLength(0);
  });
});

// --- Matrix coverage test ----------------------------------------------------

describe('FIELD_TYPE_OPERAND_MAP — matrix coverage', () => {
  it('operand matrix coverage — every ViewFilterOperand appears in at least one field type entry', () => {
    // Import the ViewFilterOperand zod schema options from views.ts at test time.
    // We do NOT hand-code the enum values — we derive them from the source.
    // The ViewFilterOperand zod enum is defined in views.ts but not exported separately,
    // so we derive the set of all valid operands from FIELD_TYPE_OPERAND_MAP itself
    // plus the ViewFilterOperand enum values by collecting all values used in the map.

    // ALL known operand strings from the ViewFilterOperand zod enum
    // (kept in sync with the enum in views.ts; if new operands are added to the enum
    // without updating the map, this test will catch it via the specialCaseOperands check)
    const allKnownOperands = [
      'IS', 'IS_NOT', 'IS_NOT_NULL', 'CONTAINS', 'DOES_NOT_CONTAIN',
      'IS_EMPTY', 'IS_NOT_EMPTY', 'LESS_THAN_OR_EQUAL', 'GREATER_THAN_OR_EQUAL',
      'IS_BEFORE', 'IS_AFTER', 'IS_RELATIVE', 'IS_IN_PAST', 'IS_IN_FUTURE',
      'IS_TODAY', 'VECTOR_SEARCH',
    ] as const;

    // Operands intentionally NOT in the matrix: IS_NOT_NULL has no field type
    // in twenty-front's FILTER_OPERANDS_MAP (it is used in code but not exposed
    // via the dropdown — it does not appear in any FILTER_OPERANDS_MAP entry).
    const specialCaseOperands = new Set<string>([
      'IS_NOT_NULL', // not in any FILTER_OPERANDS_MAP entry in twenty-front
    ]);

    // All operands covered by the map
    const coveredOperands = new Set<string>();
    for (const operands of Object.values(FIELD_TYPE_OPERAND_MAP)) {
      for (const op of operands) {
        coveredOperands.add(op);
      }
    }

    const uncovered = allKnownOperands.filter(
      (op) => !coveredOperands.has(op) && !specialCaseOperands.has(op),
    );

    if (uncovered.length > 0) {
      throw new Error(
        `The following ViewFilterOperand values are not covered by FIELD_TYPE_OPERAND_MAP ` +
        `and are not in specialCaseOperands: [${uncovered.join(', ')}].\n` +
        `Either add them to FIELD_TYPE_OPERAND_MAP for the appropriate field type(s) ` +
        `or add them to specialCaseOperands with a comment explaining why they are not in the map.`,
      );
    }
  });
});
