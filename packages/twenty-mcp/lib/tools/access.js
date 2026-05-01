"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accessToolDefinitions = exports.accessDispatchEntries = exports.buildAccessHandlers = exports.accessRevokeApiKeyInputSchema = exports.accessCreateApiKeyInputSchema = exports.accessSendInvitationsInputSchema = exports.accessUpsertFieldPermissionsInputSchema = exports.accessUpsertObjectPermissionsInputSchema = exports.accessUpdateRoleInputSchema = exports.accessCreateRoleInputSchema = void 0;
const zod_1 = require("zod");
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
exports.accessCreateRoleInputSchema = zod_1.z.object({
    label: zod_1.z.string().min(1).describe('Display name for the role.'),
    description: zod_1.z.string().optional(),
    icon: zod_1.z.string().optional(),
    // Permission flags
    canUpdateAllSettings: zod_1.z.boolean().optional(),
    canAccessAllTools: zod_1.z.boolean().optional(),
    canReadAllObjectRecords: zod_1.z.boolean().optional(),
    canUpdateAllObjectRecords: zod_1.z.boolean().optional(),
    canSoftDeleteAllObjectRecords: zod_1.z.boolean().optional(),
    canDestroyAllObjectRecords: zod_1.z.boolean().optional(),
    // Assignment flags
    canBeAssignedToUsers: zod_1.z.boolean().optional(),
    canBeAssignedToAgents: zod_1.z.boolean().optional(),
    canBeAssignedToApiKeys: zod_1.z.boolean().optional(),
});
exports.accessUpdateRoleInputSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    label: zod_1.z.string().min(1).optional(),
    description: zod_1.z.string().optional(),
    icon: zod_1.z.string().optional(),
    canUpdateAllSettings: zod_1.z.boolean().optional(),
    canAccessAllTools: zod_1.z.boolean().optional(),
    canReadAllObjectRecords: zod_1.z.boolean().optional(),
    canUpdateAllObjectRecords: zod_1.z.boolean().optional(),
    canSoftDeleteAllObjectRecords: zod_1.z.boolean().optional(),
    canDestroyAllObjectRecords: zod_1.z.boolean().optional(),
    canBeAssignedToUsers: zod_1.z.boolean().optional(),
    canBeAssignedToAgents: zod_1.z.boolean().optional(),
    canBeAssignedToApiKeys: zod_1.z.boolean().optional(),
});
const ObjectPermission = zod_1.z.object({
    objectMetadataId: zod_1.z.string().uuid(),
    canReadObjectRecords: zod_1.z.boolean().optional(),
    canUpdateObjectRecords: zod_1.z.boolean().optional(),
    canSoftDeleteObjectRecords: zod_1.z.boolean().optional(),
    canDestroyObjectRecords: zod_1.z.boolean().optional(),
});
exports.accessUpsertObjectPermissionsInputSchema = zod_1.z.object({
    roleId: zod_1.z.string().uuid(),
    objectPermissions: zod_1.z.array(ObjectPermission).min(1).max(100),
});
const FieldPermission = zod_1.z.object({
    objectMetadataId: zod_1.z.string().uuid(),
    fieldMetadataId: zod_1.z.string().uuid(),
    canReadFieldValue: zod_1.z.boolean().optional(),
    canUpdateFieldValue: zod_1.z.boolean().optional(),
});
exports.accessUpsertFieldPermissionsInputSchema = zod_1.z.object({
    roleId: zod_1.z.string().uuid(),
    fieldPermissions: zod_1.z.array(FieldPermission).min(1).max(200),
});
exports.accessSendInvitationsInputSchema = zod_1.z.object({
    emails: zod_1.z.array(zod_1.z.string().email()).min(1).max(50),
    roleId: zod_1.z.string().uuid().optional(),
});
exports.accessCreateApiKeyInputSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    expiresAt: zod_1.z
        .string()
        .describe('ISO date-time when the key expires. Twenty requires strict YYYY-MM-DDTHH:mm:ssZ format.'),
    roleId: zod_1.z.string().uuid().describe('Role to bind the key to.'),
});
exports.accessRevokeApiKeyInputSchema = zod_1.z.object({
    id: zod_1.z.string().uuid().describe('API key id to revoke.'),
});
// --- GraphQL builders --------------------------------------------------------
//
// Each builder returns the document string + variables for one mutation.
// Result-projection fields are minimal but enough for audit post-image.
const buildCreateRole = (args) => ({
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
const buildUpdateRole = (args) => {
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
const buildUpsertObjectPermissions = (args) => ({
    query: `mutation($input: UpsertObjectPermissionsInput!) {
    upsertObjectPermissions(upsertObjectPermissionsInput: $input) {
      id roleId objectMetadataId
      canReadObjectRecords canUpdateObjectRecords
      canSoftDeleteObjectRecords canDestroyObjectRecords
    }
  }`,
    variables: { input: args },
});
const buildUpsertFieldPermissions = (args) => ({
    query: `mutation($input: UpsertFieldPermissionsInput!) {
    upsertFieldPermissions(upsertFieldPermissionsInput: $input) {
      id roleId objectMetadataId fieldMetadataId
      canReadFieldValue canUpdateFieldValue
    }
  }`,
    variables: { input: args },
});
const buildSendInvitations = (args) => ({
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
const buildCreateApiKey = (args) => ({
    query: `mutation($input: CreateApiKeyInput!) {
    createApiKey(input: $input) {
      id name expiresAt revokedAt createdAt
    }
  }`,
    variables: { input: args },
});
const buildRevokeApiKey = (args) => ({
    query: `mutation($input: RevokeApiKeyInput!) {
    revokeApiKey(input: $input) {
      id name expiresAt revokedAt
    }
  }`,
    variables: { input: args },
});
// --- Handlers ----------------------------------------------------------------
const wrapGraphqlResult = (data) => ({
    content: [{ type: 'text', text: JSON.stringify({ success: true, result: data }) }],
    isError: false,
});
const buildAccessHandlers = (client) => ({
    accessCreateRole: async (args) => {
        const { query, variables } = buildCreateRole(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
    accessUpdateRole: async (args) => {
        const { query, variables } = buildUpdateRole(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
    accessUpsertObjectPermissions: async (args) => {
        const { query, variables } = buildUpsertObjectPermissions(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
    accessUpsertFieldPermissions: async (args) => {
        const { query, variables } = buildUpsertFieldPermissions(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
    accessSendInvitations: async (args) => {
        const { query, variables } = buildSendInvitations(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
    accessCreateApiKey: async (args) => {
        const { query, variables } = buildCreateApiKey(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
    accessRevokeApiKey: async (args) => {
        const { query, variables } = buildRevokeApiKey(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
});
exports.buildAccessHandlers = buildAccessHandlers;
// --- Dispatch entries (consumed by metadata.ts apply_plan) ------------------
exports.accessDispatchEntries = {
    CREATE_ROLE: {
        transport: 'graphql',
        build: (args) => buildCreateRole(args),
    },
    UPDATE_ROLE: {
        transport: 'graphql',
        build: (args) => buildUpdateRole(args),
    },
    UPSERT_OBJECT_PERMISSION: {
        transport: 'graphql',
        build: (args) => buildUpsertObjectPermissions(args),
    },
    UPSERT_FIELD_PERMISSION: {
        transport: 'graphql',
        build: (args) => buildUpsertFieldPermissions(args),
    },
    INVITE_MEMBERS: {
        transport: 'graphql',
        build: (args) => buildSendInvitations(args),
    },
    CREATE_API_KEY: {
        transport: 'graphql',
        build: (args) => buildCreateApiKey(args),
    },
    REVOKE_API_KEY: {
        transport: 'graphql',
        build: (args) => buildRevokeApiKey(args),
    },
};
// --- Tool definitions --------------------------------------------------------
exports.accessToolDefinitions = {
    access_create_role: {
        title: 'Create a workspace role',
        description: 'Create a new role with permission flags. The "Admin" role is identified by `label === "Admin"` (Twenty has no isAdmin field). Twenty errors on duplicate label (unique constraint).',
        inputSchema: exports.accessCreateRoleInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    access_update_role: {
        title: 'Update a workspace role',
        description: 'Update a role\'s label, description, icon, or permission flags. Refuse to modify the calling API key\'s own role (use metadata_get_calling_actor first).',
        inputSchema: exports.accessUpdateRoleInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    access_upsert_object_permissions: {
        title: 'Upsert object-level permissions for a role',
        description: 'Set per-object permissions (read/update/softDelete/destroy) on a role. Idempotent — re-applying the same grant is a no-op.',
        inputSchema: exports.accessUpsertObjectPermissionsInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    access_upsert_field_permissions: {
        title: 'Upsert field-level permissions for a role',
        description: 'Set per-field permissions (read/update) on a role. Idempotent. Requires the field metadata id (UUID), not the field name.',
        inputSchema: exports.accessUpsertFieldPermissionsInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    access_send_invitations: {
        title: 'Send workspace invitations',
        description: 'Send invitations to one or more email addresses, optionally bound to a role. Returns SendInvitationsDTO with `success`, `errors[]`, and `result[]` (each containing the invitation id used to join the workspace).',
        inputSchema: exports.accessSendInvitationsInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    access_create_api_key: {
        title: 'Issue a workspace API key',
        description: 'Create an API key bound to a role. Returns the key entity (id, name, expiresAt) but NO secret — Twenty generates the JWT on demand from the api-key id. Tell the user to retrieve the JWT via the Twenty UI (Settings → Developers → Generate). Audit row should record only the key id + name (never a secret).',
        inputSchema: exports.accessCreateApiKeyInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    access_revoke_api_key: {
        title: 'Revoke a workspace API key',
        description: 'Revoke an API key by id. The access agent MUST verify via metadata_get_calling_actor that the target id is NOT the calling key — refuse self-revocation.',
        inputSchema: exports.accessRevokeApiKeyInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
};
//# sourceMappingURL=access.js.map