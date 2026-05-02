import {
  buildMetadataHandlers,
  metadataApplyPlanInputSchema,
  sha256OfMutations,
} from '../tools/metadata';
import { TwentyMcpClient } from '../twenty-mcp-client';

// Stub JWT for metadata_get_calling_actor tests.
// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"WORKSPACE_X","type":"API_KEY","workspaceId":"WORKSPACE_X","iat":1700000000,"exp":1900000000,"jti":"APIKEY_X"}
const STUB_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJXT1JLU1BBQ0VfWCIsInR5cGUiOiJBUElfS0VZIiwid29ya3NwYWNlSWQiOiJXT1JLU1BBQ0VfWCIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxOTAwMDAwMDAwLCJqdGkiOiJBUElLRVlfWCJ9.signature';

const makeClient = () => {
  const toolsCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const graphqlMutation = jest.fn().mockResolvedValue({ stub: true });

  return {
    toolsCall,
    graphqlMutation,
    client: { toolsCall, graphqlMutation } as unknown as TwentyMcpClient,
    apiKey: STUB_JWT,
  };
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
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);
    await handlers.metadataQuery({ kind, args: { limit: 10 } });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: expectedInner,
      arguments: { limit: 10 },
    });
  });

  it('passes empty args when none provided', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);
    await handlers.metadataQuery({ kind: 'objects' });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'get_object_metadata',
      arguments: {},
    });
  });
});

describe('metadata_create_field — wire-level', () => {
  it('routes to create_field_metadata with the input forwarded as inner args', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

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
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

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
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

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
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

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
    const handlers = buildMetadataHandlers(client, STUB_JWT);

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
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

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
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    const mutations = [{ key: 'k1', op: 'CREATE_FIELD' as const, args: { foo: 1 } }];
    const expectedSha256 = sha256OfMutations(mutations);

    const result = await handlers.metadataApplyPlan({ mutations, expectedSha256 });

    expect(toolsCall).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });

  it('CREATE_RELATION wraps args in {relations: [...]} per Twenty\'s inner shape', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

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

// --- Phase 4 additions ------------------------------------------------------

describe('v1.1 typed tools', () => {
  it('metadataUpdateObject routes to update_object_metadata', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    await handlers.metadataUpdateObject({
      id: '00000000-0000-0000-0000-000000000001',
      labelSingular: 'Renamed',
    });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'update_object_metadata',
      arguments: { id: '00000000-0000-0000-0000-000000000001', labelSingular: 'Renamed' },
    });
  });

  it('metadataUpdateField routes to update_field_metadata (flat input)', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    await handlers.metadataUpdateField({
      id: '00000000-0000-0000-0000-000000000001',
      label: 'New Label',
      isActive: false,
    });

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'update_field_metadata',
      arguments: {
        id: '00000000-0000-0000-0000-000000000001',
        label: 'New Label',
        isActive: false,
      },
    });
  });

  it('metadataCreateManyFields routes to create_many_field_metadata with {fields: [...]}', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    const input = {
      fields: [
        {
          objectMetadataId: '00000000-0000-0000-0000-000000000001',
          type: 'TEXT',
          name: 'a',
          label: 'A',
        },
        {
          objectMetadataId: '00000000-0000-0000-0000-000000000001',
          type: 'NUMBER',
          name: 'b',
          label: 'B',
        },
      ],
    };
    await handlers.metadataCreateManyFields(input);

    expect(toolsCall).toHaveBeenCalledWith('execute_tool', {
      toolName: 'create_many_field_metadata',
      arguments: input,
    });
  });
});

describe('metadata_get_calling_actor — JWT decode', () => {
  it('decodes the bearer JWT and returns apiKeyId/workspaceId/type', async () => {
    const { client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    const result = await handlers.metadataGetCallingActor({});
    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { result: { apiKeyId: string; workspaceId: string; type: string } };

    expect(parsed.result.apiKeyId).toBe('APIKEY_X');
    expect(parsed.result.workspaceId).toBe('WORKSPACE_X');
    expect(parsed.result.type).toBe('API_KEY');
  });

  it('throws on a non-JWT bearer', async () => {
    const { client } = makeClient();
    const handlers = buildMetadataHandlers(client, 'not-a-jwt');

    await expect(handlers.metadataGetCallingActor({})).rejects.toThrow(/JWT/);
  });
});

describe('metadata_query — Phase 4 graphql kinds', () => {
  it.each(['roles', 'api_keys', 'webhooks'] as const)(
    'kind=%s routes to graphqlMutation, NOT execute_tool',
    async (kind) => {
      const { toolsCall, graphqlMutation, client, apiKey } = makeClient();
      const handlers = buildMetadataHandlers(client, apiKey);

      await handlers.metadataQuery({ kind });

      expect(toolsCall).not.toHaveBeenCalled();
      expect(graphqlMutation).toHaveBeenCalledTimes(1);
      const [query] = graphqlMutation.mock.calls[0]!;
      // Query should mention the right top-level field
      // roles uses GraphQL `getRoles` query name (verified via /metadata
      // introspection — bug #5 fix). api_keys / webhooks use bare names.
      const expectedField =
        kind === 'roles' ? 'getRoles' : kind === 'api_keys' ? 'apiKeys' : 'webhooks';
      expect(query).toContain(expectedField);
    },
  );
});

describe('metadata_apply_plan — Phase 4 dispatcher extensions', () => {
  it('routes UPDATE_OBJECT and BULK_CREATE_FIELD to inner tools', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'UPDATE_OBJECT',
          args: { id: '00000000-0000-0000-0000-000000000001', labelSingular: 'X' },
        },
        {
          key: 'k2',
          op: 'BULK_CREATE_FIELD',
          args: { fields: [{ objectMetadataId: 'o', type: 'TEXT', name: 'n', label: 'L' }] },
        },
      ],
    });

    const innerNames = toolsCall.mock.calls.map((c) => (c[1] as { toolName: string }).toolName);
    expect(innerNames).toEqual(['update_object_metadata', 'create_many_field_metadata']);
  });

  it.each([
    ['CREATE_VIEW', 'create_view'],
    ['UPDATE_VIEW', 'update_view'],
    ['CREATE_VIEW_FIELD', 'create_view_field'],
    ['UPDATE_VIEW_FIELD', 'update_view_field'],
    ['CREATE_VIEW_FILTER', 'create_view_filter'],
    ['UPDATE_VIEW_FILTER', 'update_view_filter'],
    ['CREATE_VIEW_SORT', 'create_view_sort'],
  ] as const)('view op %s routes to inner tool %s', async (op, innerTool) => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    await handlers.metadataApplyPlan({
      mutations: [{ key: 'k', op, args: { stub: true } }],
    });

    expect(toolsCall).toHaveBeenCalledWith(
      'execute_tool',
      expect.objectContaining({ toolName: innerTool }),
    );
  });

  it.each([
    ['CREATE_ROLE', 'createOneRole'],
    ['UPDATE_ROLE', 'updateOneRole'],
    ['UPSERT_OBJECT_PERMISSION', 'upsertObjectPermissions'],
    ['UPSERT_FIELD_PERMISSION', 'upsertFieldPermissions'],
    ['INVITE_MEMBERS', 'sendInvitations'],
    ['CREATE_API_KEY', 'createApiKey'],
    ['REVOKE_API_KEY', 'revokeApiKey'],
  ] as const)('access op %s routes to GraphQL mutation %s', async (op, mutationName) => {
    const { toolsCall, graphqlMutation, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    // Different ops need different minimal valid args; dispatcher passes through.
    const args =
      op === 'CREATE_ROLE'
        ? { label: 'X' }
        : op === 'UPDATE_ROLE'
          ? { id: '00000000-0000-0000-0000-000000000001', label: 'Y' }
          : op === 'UPSERT_OBJECT_PERMISSION'
            ? {
                roleId: '00000000-0000-0000-0000-000000000001',
                objectPermissions: [
                  { objectMetadataId: '00000000-0000-0000-0000-000000000002' },
                ],
              }
            : op === 'UPSERT_FIELD_PERMISSION'
              ? {
                  roleId: '00000000-0000-0000-0000-000000000001',
                  fieldPermissions: [
                    {
                      objectMetadataId: '00000000-0000-0000-0000-000000000002',
                      fieldMetadataId: '00000000-0000-0000-0000-000000000003',
                    },
                  ],
                }
              : op === 'INVITE_MEMBERS'
                ? { emails: ['a@x.com'] }
                : op === 'CREATE_API_KEY'
                  ? {
                      name: 'k',
                      expiresAt: '2027-01-01T00:00:00Z',
                      roleId: '00000000-0000-0000-0000-000000000001',
                    }
                  : { id: '00000000-0000-0000-0000-000000000001' };

    await handlers.metadataApplyPlan({
      mutations: [{ key: 'k', op, args }],
    });

    expect(toolsCall).not.toHaveBeenCalled();
    expect(graphqlMutation).toHaveBeenCalledTimes(1);
    const [query] = graphqlMutation.mock.calls[0]!;
    expect(query).toContain(mutationName);
  });

  it('reports a clear error when an op kind has no dispatch entry', async () => {
    const { client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    const result = await handlers.metadataApplyPlan({
      // @ts-expect-error — testing runtime guard for an unknown op
      mutations: [{ key: 'k', op: 'NONEXISTENT_OP', args: {} }],
    });

    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { failed: { error: string } };
    expect(parsed.failed.error).toMatch(/no dispatch entry/);
  });
});

describe('metadata_apply_plan — placeholder resolution', () => {
  it('placeholder resolved: $<key> in second mutation args is substituted with id from first mutation result', async () => {
    // k1 returns {"id":"uuid-from-k1"} — k2 references $k1 as viewId
    const toolsCall = jest
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"id":"uuid-from-k1"}' }],
        isError: false,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"id":"uuid-from-k2"}' }],
        isError: false,
      });
    const client = { toolsCall } as unknown as TwentyMcpClient;
    const handlers = buildMetadataHandlers(client, STUB_JWT);

    await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_VIEW',
          args: { name: 'My View', objectNameSingular: 'company', type: 'TABLE', visibility: 'WORKSPACE' },
        },
        {
          key: 'k2',
          op: 'CREATE_VIEW_FIELD',
          args: { viewId: '$k1', fieldMetadataId: '96314745-0000-0000-0000-000000000001', isVisible: true, position: 0 },
        },
      ],
    });

    // Second call must have had viewId substituted to the actual UUID.
    expect(toolsCall).toHaveBeenCalledTimes(2);
    const secondCall = toolsCall.mock.calls[1]![1] as { toolName: string; arguments: { viewId: string } };
    expect(secondCall.toolName).toBe('create_view_field');
    expect(secondCall.arguments.viewId).toBe('uuid-from-k1');
  });

  it('unresolved placeholder: mutation with $nonexistent_key fails with isError=true and unresolved placeholder message', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    const result = await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_VIEW_FIELD',
          args: { viewId: '$nonexistent_key', fieldMetadataId: 'some-id', isVisible: true, position: 0 },
        },
      ],
    });

    // No inner tool should have been called — the placeholder check fires before dispatch.
    expect(toolsCall).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { failed: { key: string; error: string } | null };
    expect(parsed.failed?.error).toMatch(/unresolved placeholder/);
    expect(parsed.failed?.error).toContain('nonexistent_key');
  });

  it('skipped mutation does not populate resolved map: $skipped_key fails, $applied_key resolves', async () => {
    // k1 is in resumeFrom (skipped), k2 applies and returns an id,
    // k3 references both $k1 (skipped — should fail) and $k2 (applied — should resolve).
    // Since k3 uses both placeholders and $k1 is unresolved, the plan should stop at k3.
    const toolsCall = jest
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"id":"uuid-from-k2"}' }],
        isError: false,
      });
    const client = { toolsCall } as unknown as TwentyMcpClient;
    const handlers = buildMetadataHandlers(client, STUB_JWT);

    const result = await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_VIEW',
          args: { name: 'View 1', objectNameSingular: 'company', type: 'TABLE', visibility: 'WORKSPACE' },
        },
        {
          key: 'k2',
          op: 'CREATE_VIEW',
          args: { name: 'View 2', objectNameSingular: 'company', type: 'TABLE', visibility: 'WORKSPACE' },
        },
        {
          key: 'k3',
          op: 'CREATE_VIEW_FIELD',
          // $k2 should resolve; $k1 is skipped so it will NOT resolve — expect failure.
          args: { viewId: '$k1', relatedViewId: '$k2', fieldMetadataId: 'some-id', isVisible: true, position: 0 },
        },
      ],
      resumeFrom: ['k1'],
    });

    // k2 ran (once), k3 should fail due to unresolved $k1.
    expect(toolsCall).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as {
      applied: { key: string }[];
      skipped: { key: string }[];
      failed: { key: string; error: string } | null;
    };
    expect(parsed.skipped.map((s) => s.key)).toContain('k1');
    expect(parsed.applied.map((a) => a.key)).toContain('k2');
    expect(parsed.failed?.key).toBe('k3');
    expect(parsed.failed?.error).toMatch(/unresolved placeholder/);
    expect(parsed.failed?.error).toContain('k1');
  });

  it('placeholder resolved across graphql transport: CREATE_ROLE id substituted into UPSERT_OBJECT_PERMISSION roleId', async () => {
    // k1 = CREATE_ROLE via graphql transport; returns { createOneRole: { id: 'role-uuid', label: 'X' } }
    // wrapGraphqlResult will wrap that as { success: true, result: { createOneRole: { id: 'role-uuid', label: 'X' } } }
    // The three-shape extractor must walk into parsed.result.createOneRole.id (Shape 3).
    // k2 = UPSERT_OBJECT_PERMISSION with roleId: '$k1' — must be substituted to 'role-uuid'.
    const graphqlMutation = jest
      .fn()
      // First call: CREATE_ROLE — return bare data (wrapGraphqlResult wraps it)
      .mockResolvedValueOnce({ createOneRole: { id: 'role-uuid', label: 'X' } })
      // Second call: UPSERT_OBJECT_PERMISSION
      .mockResolvedValueOnce({ upsertObjectPermissions: { success: true } });
    const client = { toolsCall: jest.fn(), graphqlMutation } as unknown as TwentyMcpClient;
    const handlers = buildMetadataHandlers(client, STUB_JWT);

    await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_ROLE',
          args: { label: 'X', name: 'x', description: '' },
        },
        {
          key: 'k2',
          op: 'UPSERT_OBJECT_PERMISSION',
          args: { roleId: '$k1', objectPermissions: [] },
        },
      ],
    });

    // Second graphqlMutation call must have roleId substituted to the actual UUID, NOT '$k1'.
    // buildUpsertObjectPermissions wraps args as { input: { roleId, objectPermissions } },
    // so variables.input.roleId is where the substituted value lands.
    expect(graphqlMutation).toHaveBeenCalledTimes(2);
    const secondCallVariables = graphqlMutation.mock.calls[1]![1] as {
      input: { roleId: string; objectPermissions: unknown[] };
    };
    expect(secondCallVariables.input.roleId).toBe('role-uuid');
    expect(secondCallVariables.input.roleId).not.toBe('$k1');
  });

  it('embedded placeholder passes through literally: only whole-string $<key> is substituted', async () => {
    // k1 = CREATE_VIEW returns { id: 'uuid-1' }
    // k2 = CREATE_VIEW_FIELD with description: "created via $k1" (embedded — should NOT substitute)
    //                          and viewId: "$k1" (whole-string — should substitute to 'uuid-1')
    const toolsCall = jest
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"id":"uuid-1"}' }],
        isError: false,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"id":"uuid-2"}' }],
        isError: false,
      });
    const client = { toolsCall, graphqlMutation: jest.fn() } as unknown as TwentyMcpClient;
    const handlers = buildMetadataHandlers(client, STUB_JWT);

    const result = await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_VIEW',
          args: { name: 'My View', objectNameSingular: 'company', type: 'TABLE', visibility: 'WORKSPACE' },
        },
        {
          key: 'k2',
          op: 'CREATE_VIEW_FIELD',
          args: {
            description: 'created via $k1',
            viewId: '$k1',
            fieldMetadataId: '96314745-0000-0000-0000-000000000001',
            isVisible: true,
            position: 0,
          },
        },
      ],
    });

    // The plan should succeed (no error for the embedded placeholder — it's a pass-through).
    expect(result.isError).toBeFalsy();
    expect(toolsCall).toHaveBeenCalledTimes(2);
    const secondCallArgs = toolsCall.mock.calls[1]![1] as {
      toolName: string;
      arguments: { description: string; viewId: string };
    };
    // Whole-string placeholder substituted.
    expect(secondCallArgs.arguments.viewId).toBe('uuid-1');
    // Embedded placeholder passed through literally (not substituted).
    expect(secondCallArgs.arguments.description).toBe('created via $k1');
  });
});

// --- apply_plan operand validation (Layer 2 — symmetric with Layer 1 in views.ts) ---

/**
 * Helper: create a toolsCall mock that returns a get_field_metadata response
 * with the given field type for any get_field_metadata call, and 'ok' for others.
 */
const makeMetadataClientWithFieldType = (fieldType: string) => {
  const fieldResponse = {
    content: [{ type: 'text', text: JSON.stringify([{ id: '00000000-0000-0000-0000-000000000003', type: fieldType, name: 'testField' }]) }],
    isError: false,
  };
  const toolsCall = jest.fn().mockImplementation((_method: string, args: { toolName?: string }) => {
    if (args.toolName === 'get_field_metadata') return Promise.resolve(fieldResponse);
    return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  });
  const graphqlMutation = jest.fn().mockResolvedValue({ stub: true });

  return {
    toolsCall,
    graphqlMutation,
    client: { toolsCall, graphqlMutation } as unknown as TwentyMcpClient,
    apiKey: STUB_JWT,
  };
};

describe('metadata_apply_plan — operand validation (Layer 2)', () => {
  it('apply_plan CREATE_VIEW_FILTER operand rejected', async () => {
    // Two-mutation plan: CREATE_VIEW (mock success) + CREATE_VIEW_FILTER with bad operand.
    const { toolsCall, client, apiKey } = makeMetadataClientWithFieldType('DATE_TIME');
    const handlers = buildMetadataHandlers(client, apiKey);

    // First call for CREATE_VIEW returns { id: 'view-uuid' }
    toolsCall.mockImplementationOnce((_: string, args: { toolName?: string }) => {
      if (args.toolName === 'create_view') {
        return Promise.resolve({ content: [{ type: 'text', text: '{"id":"view-uuid"}' }], isError: false });
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    });

    const result = await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'CREATE_VIEW',
          args: { name: 'My View', objectNameSingular: 'company', visibility: 'WORKSPACE' },
        },
        {
          key: 'k2',
          op: 'CREATE_VIEW_FILTER',
          args: {
            viewId: 'view-uuid',
            fieldMetadataId: '00000000-0000-0000-0000-000000000003',
            operand: 'GREATER_THAN_OR_EQUAL',
            value: '2026-01-01T00:00:00Z',
          },
        },
      ],
    });

    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { applied: { key: string }[]; failed: { op: string; error: string } | null };

    expect(parsed.failed?.op).toBe('CREATE_VIEW_FILTER');
    expect(parsed.failed?.error).toMatch(/not valid for DATE_TIME/);
    expect(parsed.applied.map((a) => a.key)).toEqual(['k1']);

    // create_view_filter must NOT have been called
    const createCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'create_view_filter',
    );
    expect(createCalls).toHaveLength(0);
  });

  it('apply_plan UPDATE_VIEW_FILTER without fieldMetadataId fails closed', async () => {
    const { toolsCall, client, apiKey } = makeMetadataClientWithFieldType('SELECT');
    const handlers = buildMetadataHandlers(client, apiKey);

    const result = await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'UPDATE_VIEW_FILTER',
          args: {
            id: '00000000-0000-0000-0000-000000000001',
            operand: 'IS_AFTER',
            // no fieldMetadataId
          },
        },
      ],
    });

    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { failed: { op: string; error: string } | null };

    expect(parsed.failed?.op).toBe('UPDATE_VIEW_FILTER');
    expect(parsed.failed?.error).toMatch(/requires fieldMetadataId/);

    // update_view_filter must NOT have been called
    const updateCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'update_view_filter',
    );
    expect(updateCalls).toHaveLength(0);
  });
});

describe('metadata_apply_plan — apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId', () => {
  it('apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId to inner tool', async () => {
    // Exercises the argsTransform on the UPDATE_VIEW_FILTER dispatch entry (HIGH-1 fix).
    // Without the argsTransform, fieldMetadataId leaks through the apply_plan path even
    // though the direct handler strips it — the apply_plan path is a separate call site.
    const { toolsCall, client, apiKey } = makeMetadataClientWithFieldType('SELECT');
    const handlers = buildMetadataHandlers(client, apiKey);

    await handlers.metadataApplyPlan({
      mutations: [
        {
          key: 'k1',
          op: 'UPDATE_VIEW_FILTER',
          args: {
            id: '00000000-0000-0000-0000-000000000001',
            operand: 'IS',
            value: 'TIER_A',
            fieldMetadataId: '00000000-0000-0000-0000-000000000003',
          },
        },
      ],
    });

    const updateCalls = toolsCall.mock.calls.filter(
      (c) => (c[1] as { toolName: string })?.toolName === 'update_view_filter',
    );
    expect(updateCalls).toHaveLength(1);
    const forwardedArgs = (updateCalls[0]?.[1] as { arguments: Record<string, unknown> })?.arguments ?? {};
    expect(forwardedArgs).not.toHaveProperty('fieldMetadataId');
    expect(forwardedArgs).toHaveProperty('id', '00000000-0000-0000-0000-000000000001');
    expect(forwardedArgs).toHaveProperty('operand', 'IS');
  });
});

describe('metadata_compute_plan_hash', () => {
  it('compute_plan_hash returns the same hash as sha256OfMutations', () => {
    const { toolsCall, graphqlMutation, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    const mutations = [{ key: 'k1', op: 'CREATE_FIELD' as const, args: { foo: 1 } }];
    const result = handlers.metadataComputePlanHash({ mutations });

    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { hash: string };
    expect(parsed.hash).toBe(sha256OfMutations(mutations));
    expect(parsed.hash).toMatch(/^[a-f0-9]{64}$/);
    // Pure — neither inner tool nor GraphQL was called.
    expect(toolsCall).not.toHaveBeenCalled();
    expect(graphqlMutation).not.toHaveBeenCalled();
  });

  it('hash round-trip: compute then apply succeeds without SHA256_CHECK failure', async () => {
    const { toolsCall, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    const mutations = [{ key: 'k1', op: 'CREATE_FIELD' as const, args: { foo: 1 } }];
    const hashResult = handlers.metadataComputePlanHash({ mutations });
    const { hash } = JSON.parse(
      (hashResult.content[0] as { type: 'text'; text: string }).text,
    ) as { hash: string };

    const applyResult = await handlers.metadataApplyPlan({ mutations, expectedSha256: hash });

    expect(applyResult.isError).toBe(false);
    const parsed = JSON.parse(
      (applyResult.content[0] as { type: 'text'; text: string }).text,
    ) as { failed: { op: string } | null };
    expect(parsed.failed).toBeNull();
    expect(toolsCall).toHaveBeenCalledTimes(1);
  });

  it('compute_plan_hash is pure: toolsCall and graphqlMutation are NOT called', () => {
    const { toolsCall, graphqlMutation, client, apiKey } = makeClient();
    const handlers = buildMetadataHandlers(client, apiKey);

    handlers.metadataComputePlanHash({
      mutations: [{ key: 'k1', op: 'CREATE_FIELD' as const, args: { name: 'x', label: 'X' } }],
    });

    expect(toolsCall).not.toHaveBeenCalled();
    expect(graphqlMutation).not.toHaveBeenCalled();
  });
});
