import { z } from 'zod';

import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';
import type { DispatchEntry } from './metadata';

/**
 * Access-management tools: roles, object/field permissions, member invitations,
 * API keys.
 *
 * Twenty does NOT expose inner MCP tools for any of these — they're GraphQL
 * resolvers only (`createOneRole`, `upsertObjectPermissions`, `sendInvitations`,
 * `createApiKey`, `revokeApiKey`). The proxy reaches them via
 * `TwentyMcpClient.graphqlMutation()` which POSTs to `/metadata`.
 *
 * Per-mutation arg-name quirks (verified by reading role.resolver.ts and
 * api-key.resolver.ts):
 *
 * - `createOneRole(createRoleInput: CreateRoleInput!)`
 * - `updateOneRole(updateRoleInput: UpdateRoleInput!)` — and the input itself
 *   is nested: `{id: UUID!, update: UpdateRolePayload!}`. Tool accepts flat
 *   `{id, label?, ...}` and reshapes for the GraphQL call.
 * - `upsertObjectPermissions(upsertObjectPermissionsInput: ...!)`
 * - `upsertFieldPermissions(upsertFieldPermissionsInput: ...!)`
 * - `sendInvitations(emails: [String!]!, roleId: UUID)` — uses `@Args()` with
 *   no wrapper name, so input fields spread as top-level args (NOT
 *   `sendInvitations(input: {...})`).
 * - `createApiKey(input: CreateApiKeyInput!)` — generic `input` name.
 * - `revokeApiKey(input: RevokeApiKeyInput!)` — same.
 *
 * Refused in v1: webhooks (no proxy tool ships in this patch — exfil channel,
 * v2 deferral with proper approval flow). updateWorkspaceMemberRole is also
 * deferred — UI-only for v1.
 *
 * API-key secret quirk: createApiKey returns ApiKeyEntity (id, name, …) but
 * NO secret. Twenty generates the JWT on demand from the api-key id; secret
 * is never persisted. The access agent returns {id, name, expiresAt} to the
 * user and instructs them to retrieve the JWT via the Twenty UI.
 */

// --- Input schemas (mirror Twenty's GraphQL Input types) -------------------

export const accessCreateRoleInputSchema = z.object({
  label: z.string().min(1).describe('Display name for the role.'),
  description: z.string().optional(),
  icon: z.string().optional(),
  // Permission flags
  canUpdateAllSettings: z.boolean().optional(),
  canAccessAllTools: z.boolean().optional(),
  canReadAllObjectRecords: z.boolean().optional(),
  canUpdateAllObjectRecords: z.boolean().optional(),
  canSoftDeleteAllObjectRecords: z.boolean().optional(),
  canDestroyAllObjectRecords: z.boolean().optional(),
  // Assignment flags
  canBeAssignedToUsers: z.boolean().optional(),
  canBeAssignedToAgents: z.boolean().optional(),
  canBeAssignedToApiKeys: z.boolean().optional(),
});

export const accessUpdateRoleInputSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  canUpdateAllSettings: z.boolean().optional(),
  canAccessAllTools: z.boolean().optional(),
  canReadAllObjectRecords: z.boolean().optional(),
  canUpdateAllObjectRecords: z.boolean().optional(),
  canSoftDeleteAllObjectRecords: z.boolean().optional(),
  canDestroyAllObjectRecords: z.boolean().optional(),
  canBeAssignedToUsers: z.boolean().optional(),
  canBeAssignedToAgents: z.boolean().optional(),
  canBeAssignedToApiKeys: z.boolean().optional(),
});

const ObjectPermission = z.object({
  objectMetadataId: z.string().uuid(),
  canReadObjectRecords: z.boolean().optional(),
  canUpdateObjectRecords: z.boolean().optional(),
  canSoftDeleteObjectRecords: z.boolean().optional(),
  canDestroyObjectRecords: z.boolean().optional(),
});

export const accessUpsertObjectPermissionsInputSchema = z.object({
  roleId: z.string().uuid(),
  objectPermissions: z.array(ObjectPermission).min(1).max(100),
});

const FieldPermission = z.object({
  objectMetadataId: z.string().uuid(),
  fieldMetadataId: z.string().uuid(),
  canReadFieldValue: z.boolean().optional(),
  canUpdateFieldValue: z.boolean().optional(),
});

export const accessUpsertFieldPermissionsInputSchema = z.object({
  roleId: z.string().uuid(),
  fieldPermissions: z.array(FieldPermission).min(1).max(200),
});

export const accessSendInvitationsInputSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(50),
  roleId: z.string().uuid().optional(),
});

export const accessCreateApiKeyInputSchema = z.object({
  name: z.string().min(1),
  expiresAt: z
    .string()
    .describe('ISO date-time when the key expires. Twenty requires strict YYYY-MM-DDTHH:mm:ssZ format.'),
  roleId: z.string().uuid().describe('Role to bind the key to.'),
});

export const accessRevokeApiKeyInputSchema = z.object({
  id: z.string().uuid().describe('API key id to revoke.'),
});

// --- GraphQL builders --------------------------------------------------------
//
// Each builder returns the document string + variables for one mutation.
// Result-projection fields are minimal but enough for audit post-image.

const buildCreateRole = (
  args: z.infer<typeof accessCreateRoleInputSchema>,
): { query: string; variables: Record<string, unknown> } => ({
  query: `mutation($input: CreateRoleInput!) {
    createOneRole(createRoleInput: $input) {
      id label description icon
      canUpdateAllSettings canAccessAllTools
      canReadAllObjectRecords canUpdateAllObjectRecords
      canSoftDeleteAllObjectRecords canDestroyAllObjectRecords
      canBeAssignedToUsers canBeAssignedToAgents canBeAssignedToApiKeys
    }
  }`,
  variables: { input: args },
});

const buildUpdateRole = (
  args: z.infer<typeof accessUpdateRoleInputSchema>,
): { query: string; variables: Record<string, unknown> } => {
  // GraphQL UpdateRoleInput is {id, update: UpdateRolePayload}.
  const { id, ...rest } = args;

  return {
    query: `mutation($input: UpdateRoleInput!) {
      updateOneRole(updateRoleInput: $input) {
        id label description icon
        canUpdateAllSettings canAccessAllTools
        canReadAllObjectRecords canUpdateAllObjectRecords
        canSoftDeleteAllObjectRecords canDestroyAllObjectRecords
      }
    }`,
    variables: { input: { id, update: rest } },
  };
};

const buildUpsertObjectPermissions = (
  args: z.infer<typeof accessUpsertObjectPermissionsInputSchema>,
): { query: string; variables: Record<string, unknown> } => ({
  // ObjectPermission type on this Twenty version has no `id` or `roleId` —
  // identity is composite (roleId comes from the input, objectMetadataId is
  // on the row). Verified via /metadata introspection: bug #6 from
  // plans/audit-and-safeguards.md.
  query: `mutation($input: UpsertObjectPermissionsInput!) {
    upsertObjectPermissions(upsertObjectPermissionsInput: $input) {
      objectMetadataId
      canReadObjectRecords canUpdateObjectRecords
      canSoftDeleteObjectRecords canDestroyObjectRecords
    }
  }`,
  variables: { input: args },
});

const buildUpsertFieldPermissions = (
  args: z.infer<typeof accessUpsertFieldPermissionsInputSchema>,
): { query: string; variables: Record<string, unknown> } => ({
  query: `mutation($input: UpsertFieldPermissionsInput!) {
    upsertFieldPermissions(upsertFieldPermissionsInput: $input) {
      id roleId objectMetadataId fieldMetadataId
      canReadFieldValue canUpdateFieldValue
    }
  }`,
  variables: { input: args },
});

const buildSendInvitations = (
  args: z.infer<typeof accessSendInvitationsInputSchema>,
): { query: string; variables: Record<string, unknown> } => ({
  // sendInvitations uses @Args() (no wrapper) — input fields spread as
  // top-level args, not wrapped under `input:`.
  query: `mutation($emails: [String!]!, $roleId: UUID) {
    sendInvitations(emails: $emails, roleId: $roleId) {
      success
      errors
      result { id email roleId expiresAt }
    }
  }`,
  variables: { emails: args.emails, roleId: args.roleId ?? null },
});

const buildCreateApiKey = (
  args: z.infer<typeof accessCreateApiKeyInputSchema>,
): { query: string; variables: Record<string, unknown> } => ({
  query: `mutation($input: CreateApiKeyInput!) {
    createApiKey(input: $input) {
      id name expiresAt revokedAt createdAt
    }
  }`,
  variables: { input: args },
});

const buildRevokeApiKey = (
  args: z.infer<typeof accessRevokeApiKeyInputSchema>,
): { query: string; variables: Record<string, unknown> } => ({
  query: `mutation($input: RevokeApiKeyInput!) {
    revokeApiKey(input: $input) {
      id name expiresAt revokedAt
    }
  }`,
  variables: { input: args },
});

// --- Handlers ----------------------------------------------------------------

const wrapGraphqlResult = (data: unknown): ToolsCallResult => ({
  content: [{ type: 'text', text: JSON.stringify({ success: true, result: data }) }],
  isError: false,
});

export const buildAccessHandlers = (client: TwentyMcpClient) => ({
  accessCreateRole: async (
    args: z.infer<typeof accessCreateRoleInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildCreateRole(args);
    const data = await client.graphqlMutation(query, variables);

    return wrapGraphqlResult(data);
  },

  accessUpdateRole: async (
    args: z.infer<typeof accessUpdateRoleInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildUpdateRole(args);
    const data = await client.graphqlMutation(query, variables);

    return wrapGraphqlResult(data);
  },

  accessUpsertObjectPermissions: async (
    args: z.infer<typeof accessUpsertObjectPermissionsInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildUpsertObjectPermissions(args);
    const data = await client.graphqlMutation(query, variables);

    return wrapGraphqlResult(data);
  },

  accessUpsertFieldPermissions: async (
    args: z.infer<typeof accessUpsertFieldPermissionsInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildUpsertFieldPermissions(args);
    const data = await client.graphqlMutation(query, variables);

    return wrapGraphqlResult(data);
  },

  accessSendInvitations: async (
    args: z.infer<typeof accessSendInvitationsInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildSendInvitations(args);
    const data = await client.graphqlMutation(query, variables);

    return wrapGraphqlResult(data);
  },

  accessCreateApiKey: async (
    args: z.infer<typeof accessCreateApiKeyInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildCreateApiKey(args);
    const data = await client.graphqlMutation(query, variables);

    return wrapGraphqlResult(data);
  },

  accessRevokeApiKey: async (
    args: z.infer<typeof accessRevokeApiKeyInputSchema>,
  ): Promise<ToolsCallResult> => {
    const { query, variables } = buildRevokeApiKey(args);
    const data = await client.graphqlMutation(query, variables);

    return wrapGraphqlResult(data);
  },
});

// --- Dispatch entries (consumed by metadata.ts apply_plan) ------------------

export const accessDispatchEntries: Record<string, DispatchEntry> = {
  CREATE_ROLE: {
    transport: 'graphql',
    build: (args) => buildCreateRole(args as z.infer<typeof accessCreateRoleInputSchema>),
  },
  UPDATE_ROLE: {
    transport: 'graphql',
    build: (args) => buildUpdateRole(args as z.infer<typeof accessUpdateRoleInputSchema>),
  },
  UPSERT_OBJECT_PERMISSION: {
    transport: 'graphql',
    build: (args) =>
      buildUpsertObjectPermissions(
        args as z.infer<typeof accessUpsertObjectPermissionsInputSchema>,
      ),
  },
  UPSERT_FIELD_PERMISSION: {
    transport: 'graphql',
    build: (args) =>
      buildUpsertFieldPermissions(
        args as z.infer<typeof accessUpsertFieldPermissionsInputSchema>,
      ),
  },
  INVITE_MEMBERS: {
    transport: 'graphql',
    build: (args) => buildSendInvitations(args as z.infer<typeof accessSendInvitationsInputSchema>),
  },
  CREATE_API_KEY: {
    transport: 'graphql',
    build: (args) => buildCreateApiKey(args as z.infer<typeof accessCreateApiKeyInputSchema>),
  },
  REVOKE_API_KEY: {
    transport: 'graphql',
    build: (args) => buildRevokeApiKey(args as z.infer<typeof accessRevokeApiKeyInputSchema>),
  },
};

// --- Tool definitions --------------------------------------------------------

export const accessToolDefinitions = {
  access_create_role: {
    title: 'Create a workspace role',
    description:
      'Create a new role with permission flags. The "Admin" role is identified by `label === "Admin"` (Twenty has no isAdmin field). Twenty errors on duplicate label (unique constraint).',
    inputSchema: accessCreateRoleInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  access_update_role: {
    title: 'Update a workspace role',
    description:
      'Update a role\'s label, description, icon, or permission flags. Refuse to modify the calling API key\'s own role (use metadata_get_calling_actor first).',
    inputSchema: accessUpdateRoleInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  access_upsert_object_permissions: {
    title: 'Upsert object-level permissions for a role',
    description:
      'Set per-object permissions (read/update/softDelete/destroy) on a role. Idempotent — re-applying the same grant is a no-op.',
    inputSchema: accessUpsertObjectPermissionsInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  access_upsert_field_permissions: {
    title: 'Upsert field-level permissions for a role',
    description:
      'Set per-field permissions (read/update) on a role. Idempotent. Requires the field metadata id (UUID), not the field name.',
    inputSchema: accessUpsertFieldPermissionsInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  access_send_invitations: {
    title: 'Send workspace invitations',
    description:
      'Send invitations to one or more email addresses, optionally bound to a role. Returns SendInvitationsDTO with `success`, `errors[]`, and `result[]` (each containing the invitation id used to join the workspace).',
    inputSchema: accessSendInvitationsInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  access_create_api_key: {
    title: 'Issue a workspace API key',
    description:
      'Create an API key bound to a role. Returns the key entity (id, name, expiresAt) but NO secret — Twenty generates the JWT on demand from the api-key id. Tell the user to retrieve the JWT via the Twenty UI (Settings → Developers → Generate). Audit row should record only the key id + name (never a secret).',
    inputSchema: accessCreateApiKeyInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  access_revoke_api_key: {
    title: 'Revoke a workspace API key',
    description:
      'Revoke an API key by id. The access agent MUST verify via metadata_get_calling_actor that the target id is NOT the calling key — refuse self-revocation.',
    inputSchema: accessRevokeApiKeyInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
} as const;
