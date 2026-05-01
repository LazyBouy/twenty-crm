import {
  buildMetadataHandlers,
  metadataApplyPlanInputSchema,
  sha256OfMutations,
} from '../tools/metadata';
import { TwentyMcpClient } from '../twenty-mcp-client';

const makeClient = () => {
  const toolsCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

  return { toolsCall, client: { toolsCall } as unknown as TwentyMcpClient };
};

describe('metadata_query — wire-level', () => {
  it.each([
    ['objects', 'get_object_metadata'],
    ['fields', 'get_field_metadata'],
    ['views', 'get_views'],
    ['view_fields', 'get_view_fields'],
    ['view_filters', 'get_view_filters'],
    ['view_sorts', 'get_view_sorts'],
  ] as const)('kind=%s routes to %s', async (kind, expectedInner) => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);
    await handlers.metadataQuery({ kind, args: { limit: 10 } });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: expectedInner,
      arguments: { limit: 10 },
    });
  });

  it('passes empty args when none provided', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);
    await handlers.metadataQuery({ kind: 'objects' });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'get_object_metadata',
      arguments: {},
    });
  });
});

describe('metadata_create_field — wire-level', () => {
  it('routes to create_field_metadata with the input forwarded as inner args', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);

    const input = {
      objectMetadataId: '00000000-0000-0000-0000-000000000001',
      type: 'NUMBER',
      name: 'icpScore',
      label: 'ICP Score',
      description: 'fit score',
      isLabelSyncedWithName: false,
    };
    await handlers.metadataCreateField(input);

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'create_field_metadata',
      arguments: input,
    });
  });
});

describe('metadata_create_relation — wraps single relation into Twenty\'s array shape', () => {
  it('wraps the input in {relations: [...]} for create_many_relation_fields', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);

    const input = {
      objectMetadataId: '00000000-0000-0000-0000-000000000001',
      name: 'company',
      label: 'Company',
      type: 'MANY_TO_ONE' as const,
      targetObjectMetadataId: '00000000-0000-0000-0000-000000000002',
      targetFieldLabel: 'Audits',
      targetFieldIcon: 'IconHistory',
    };
    await handlers.metadataCreateRelation(input);

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'create_many_relation_fields',
      arguments: { relations: [input] },
    });
  });
});

describe('metadata_apply_plan — dispatch + idempotency + hash check', () => {
  it('dispatches each mutation to the right inner tool and reports results', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);

    const result = await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_FIELD',
          args: { objectMetadataId: 'obj1', type: 'TEXT', name: 'foo', label: 'Foo' },
        },
        {
          key: 'k2',
          op: 'CREATE_OBJECT',
          args: {
            nameSingular: 'foo',
            namePlural: 'foos',
            labelSingular: 'Foo',
            labelPlural: 'Foos',
          },
        },
      ],
    });

    const innerNames = toolsCall.mock.calls.map((c) => (c[1] as { toolName: string }).toolName);
    expect(innerNames).toEqual(['create_field_metadata', 'create_object_metadata']);

    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { applied: { key: string }[]; skipped: unknown[]; failed: unknown };
    expect(parsed.applied.map((a) => a.key)).toEqual(['k1', 'k2']);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.failed).toBeNull();
  });

  it('skips mutations listed in resumeFrom', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);

    await handlers.metadataApplyPlan({
      mutations: [
        { key: 'k1', op: 'CREATE_FIELD', args: { foo: 1 } },
        { key: 'k2', op: 'CREATE_FIELD', args: { foo: 2 } },
        { key: 'k3', op: 'CREATE_FIELD', args: { foo: 3 } },
      ],
      resumeFrom: ['k1', 'k2'],
    });

    expect(toolsCall).toHaveBeenCalledTimes(1);
    expect((toolsCall.mock.calls[0]![1] as { arguments: { foo: number } }).arguments.foo).toBe(3);
  });

  it('stops on first failure and reports applied + failed', async () => {
    const toolsCall = jest
      .fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
      .mockRejectedValueOnce(new Error('boom'));
    const client = { toolsCall } as unknown as TwentyMcpClient;
    const handlers = buildMetadataHandlers(client);

    const result = await handlers.metadataApplyPlan({
      mutations: [
        { key: 'k1', op: 'CREATE_FIELD', args: {} },
        { key: 'k2', op: 'CREATE_FIELD', args: {} },
        { key: 'k3', op: 'CREATE_FIELD', args: {} },
      ],
    });

    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { applied: { key: string }[]; failed: { key: string; error: string } | null };
    expect(parsed.applied.map((a) => a.key)).toEqual(['k1']);
    expect(parsed.failed?.key).toBe('k2');
    expect(parsed.failed?.error).toBe('boom');
    expect(toolsCall).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
  });

  it('refuses on expectedSha256 mismatch without calling any inner tool', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);

    const result = await handlers.metadataApplyPlan({
      mutations: [{ key: 'k1', op: 'CREATE_FIELD', args: { foo: 1 } }],
      expectedSha256: '0'.repeat(64),
    });

    expect(toolsCall).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { failed: { op: string; error: string } | null };
    expect(parsed.failed?.op).toBe('SHA256_CHECK');
  });

  it('accepts a matching expectedSha256 and proceeds', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);

    const mutations = [{ key: 'k1', op: 'CREATE_FIELD' as const, args: { foo: 1 } }];
    const expectedSha256 = sha256OfMutations(mutations);

    const result = await handlers.metadataApplyPlan({ mutations, expectedSha256 });

    expect(toolsCall).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });

  it('CREATE_RELATION wraps args in {relations: [...]} per Twenty\'s inner shape', async () => {
    const { toolsCall, client } = makeClient();
    const handlers = buildMetadataHandlers(client);

    await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_RELATION',
          args: {
            objectMetadataId: 'src',
            name: 'company',
            label: 'Company',
            type: 'MANY_TO_ONE',
            targetObjectMetadataId: 'tgt',
            targetFieldLabel: 'Audits',
            targetFieldIcon: 'IconHistory',
          },
        },
      ],
    });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'create_many_relation_fields',
      arguments: {
        relations: [
          {
            objectMetadataId: 'src',
            name: 'company',
            label: 'Company',
            type: 'MANY_TO_ONE',
            targetObjectMetadataId: 'tgt',
            targetFieldLabel: 'Audits',
            targetFieldIcon: 'IconHistory',
          },
        ],
      },
    });
  });
});

describe('sha256OfMutations — canonical hashing', () => {
  it('produces the same hash regardless of key order in args', () => {
    const a = sha256OfMutations([{ key: 'k1', op: 'CREATE_FIELD', args: { name: 'x', label: 'X' } }]);
    const b = sha256OfMutations([{ key: 'k1', op: 'CREATE_FIELD', args: { label: 'X', name: 'x' } }]);
    expect(a).toBe(b);
  });

  it('changes when any nested value changes', () => {
    const a = sha256OfMutations([{ key: 'k1', op: 'CREATE_FIELD', args: { name: 'x' } }]);
    const b = sha256OfMutations([{ key: 'k1', op: 'CREATE_FIELD', args: { name: 'y' } }]);
    expect(a).not.toBe(b);
  });

  it('input schema accepts a 64-char lowercase hex sha256', () => {
    const valid = metadataApplyPlanInputSchema.safeParse({
      mutations: [{ key: 'k', op: 'CREATE_FIELD', args: {} }],
      expectedSha256: 'a'.repeat(64),
    });
    expect(valid.success).toBe(true);

    const invalid = metadataApplyPlanInputSchema.safeParse({
      mutations: [{ key: 'k', op: 'CREATE_FIELD', args: {} }],
      expectedSha256: 'A'.repeat(64),
    });
    expect(invalid.success).toBe(false);
  });
});
