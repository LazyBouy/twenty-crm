import { accessDispatchEntries, buildAccessHandlers } from '../tools/access';
import { TwentyMcpClient } from '../twenty-mcp-client';

const makeClient = () => {
  const toolsCall = jest.fn();
  const graphqlMutation = jest.fn().mockResolvedValue({ stub: true });

  return {
    toolsCall,
    graphqlMutation,
    client: { toolsCall, graphqlMutation } as unknown as TwentyMcpClient,
  };
};

describe('access — GraphQL passthrough wire-level', () => {
  it('accessCreateRole calls graphqlMutation with createOneRole + createRoleInput wrapper', async () => {
    const { graphqlMutation, client } = makeClient();
    const handlers = buildAccessHandlers(client);

    await handlers.accessCreateRole({
      label: 'Analyst',
      description: 'Read-only',
      canReadAllObjectRecords: true,
    });

    expect(graphqlMutation).toHaveBeenCalledTimes(1);
    const [query, variables] = graphqlMutation.mock.calls[0]!;
    expect(query).toContain('createOneRole(createRoleInput: $input)');
    expect(variables).toEqual({
      input: {
        label: 'Analyst',
        description: 'Read-only',
        canReadAllObjectRecords: true,
      },
    });
  });

  it('accessUpdateRole reshapes flat input into {id, update: {...}}', async () => {
    const { graphqlMutation, client } = makeClient();
    const handlers = buildAccessHandlers(client);

    await handlers.accessUpdateRole({
      id: '00000000-0000-0000-0000-000000000001',
      label: 'Analyst (renamed)',
      canUpdateAllObjectRecords: false,
    });

    const [query, variables] = graphqlMutation.mock.calls[0]!;
    expect(query).toContain('updateOneRole(updateRoleInput: $input)');
    expect(variables).toEqual({
      input: {
        id: '00000000-0000-0000-0000-000000000001',
        update: {
          label: 'Analyst (renamed)',
          canUpdateAllObjectRecords: false,
        },
      },
    });
  });

  it('accessUpsertObjectPermissions wraps in upsertObjectPermissionsInput', async () => {
    const { graphqlMutation, client } = makeClient();
    const handlers = buildAccessHandlers(client);

    await handlers.accessUpsertObjectPermissions({
      roleId: '00000000-0000-0000-0000-000000000001',
      objectPermissions: [
        {
          objectMetadataId: '00000000-0000-0000-0000-000000000002',
          canReadObjectRecords: true,
          canUpdateObjectRecords: false,
        },
      ],
    });

    const [query, variables] = graphqlMutation.mock.calls[0]!;
    expect(query).toContain('upsertObjectPermissions(upsertObjectPermissionsInput: $input)');
    expect((variables as { input: { roleId: string } }).input.roleId).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
  });

  it('accessSendInvitations spreads emails + roleId as top-level args (no wrapper)', async () => {
    const { graphqlMutation, client } = makeClient();
    const handlers = buildAccessHandlers(client);

    await handlers.accessSendInvitations({
      emails: ['a@x.com', 'b@x.com'],
      roleId: '00000000-0000-0000-0000-000000000001',
    });

    const [query, variables] = graphqlMutation.mock.calls[0]!;
    expect(query).toContain('sendInvitations(emails: $emails, roleId: $roleId)');
    expect(variables).toEqual({
      emails: ['a@x.com', 'b@x.com'],
      roleId: '00000000-0000-0000-0000-000000000001',
    });
  });

  it('accessSendInvitations passes null roleId when omitted', async () => {
    const { graphqlMutation, client } = makeClient();
    const handlers = buildAccessHandlers(client);

    await handlers.accessSendInvitations({ emails: ['a@x.com'] });

    const [, variables] = graphqlMutation.mock.calls[0]!;
    expect((variables as { roleId: unknown }).roleId).toBeNull();
  });

  it('accessCreateApiKey uses generic input wrapper', async () => {
    const { graphqlMutation, client } = makeClient();
    const handlers = buildAccessHandlers(client);

    await handlers.accessCreateApiKey({
      name: 'integration',
      expiresAt: '2027-01-01T00:00:00Z',
      roleId: '00000000-0000-0000-0000-000000000001',
    });

    const [query] = graphqlMutation.mock.calls[0]!;
    expect(query).toContain('createApiKey(input: $input)');
  });

  it('accessRevokeApiKey uses generic input wrapper', async () => {
    const { graphqlMutation, client } = makeClient();
    const handlers = buildAccessHandlers(client);

    await handlers.accessRevokeApiKey({ id: '00000000-0000-0000-0000-000000000001' });

    const [query, variables] = graphqlMutation.mock.calls[0]!;
    expect(query).toContain('revokeApiKey(input: $input)');
    expect(variables).toEqual({ input: { id: '00000000-0000-0000-0000-000000000001' } });
  });
});

describe('access — dispatch entries', () => {
  it('cover the 7 plan op kinds for access', () => {
    expect(Object.keys(accessDispatchEntries).sort()).toEqual([
      'CREATE_API_KEY',
      'CREATE_ROLE',
      'INVITE_MEMBERS',
      'REVOKE_API_KEY',
      'UPDATE_ROLE',
      'UPSERT_FIELD_PERMISSION',
      'UPSERT_OBJECT_PERMISSION',
    ]);
  });

  it('all access dispatch entries use graphql transport', () => {
    for (const entry of Object.values(accessDispatchEntries)) {
      expect(entry.transport).toBe('graphql');
      expect(typeof (entry as { build: unknown }).build).toBe('function');
    }
  });
});
