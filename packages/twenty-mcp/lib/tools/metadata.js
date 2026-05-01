"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metadataToolDefinitions = exports.buildMetadataHandlers = exports.sha256OfMutations = exports.metadataApplyPlanInputSchema = exports.ApplyPlanOpKind = exports.metadataGetCallingActorInputSchema = exports.metadataCreateRelationInputSchema = exports.metadataCreateManyFieldsInputSchema = exports.metadataUpdateFieldInputSchema = exports.metadataCreateFieldInputSchema = exports.metadataUpdateObjectInputSchema = exports.metadataCreateObjectInputSchema = exports.metadataQueryInputSchema = void 0;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const access_1 = require("./access");
const views_1 = require("./views");
// --- Input schemas (mirror Twenty's inner-tool schemas) ---------------------
const MetadataQueryKind = zod_1.z.enum([
    // Inner-tool kinds
    'objects',
    'fields',
    'views',
    'view_fields',
    'view_filters',
    'view_sorts',
    // GraphQL kinds (added in Phase 4)
    'roles',
    'api_keys',
    'webhooks',
]);
exports.metadataQueryInputSchema = zod_1.z.object({
    kind: MetadataQueryKind.describe('Which metadata catalog to read. `objects/fields/views/view_*` route to inner tools; `roles/api_keys/webhooks` route to GraphQL queries since Twenty does not expose them as inner tools.'),
    args: zod_1.z
        .record(zod_1.z.string(), zod_1.z.unknown())
        .optional()
        .describe('Inner-tool arguments — typically `{id?, objectMetadataId?, limit?}` for fields, etc. Ignored for GraphQL kinds (roles/api_keys/webhooks); they always return the full list.'),
});
exports.metadataCreateObjectInputSchema = zod_1.z.object({
    nameSingular: zod_1.z
        .string()
        .min(1)
        .describe('Singular camelCase name (e.g. "schemaChangeAudit").'),
    namePlural: zod_1.z
        .string()
        .min(1)
        .describe('Plural camelCase name (e.g. "schemaChangeAudits").'),
    labelSingular: zod_1.z.string().min(1).describe('Display label, singular.'),
    labelPlural: zod_1.z.string().min(1).describe('Display label, plural.'),
    description: zod_1.z.string().optional(),
    icon: zod_1.z.string().optional().describe('e.g. "IconHistory" — see Twenty\'s icon set.'),
    shortcut: zod_1.z.string().optional(),
    isRemote: zod_1.z.boolean().optional(),
    isLabelSyncedWithName: zod_1.z.boolean().optional(),
});
exports.metadataUpdateObjectInputSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    nameSingular: zod_1.z.string().min(1).optional(),
    namePlural: zod_1.z.string().min(1).optional(),
    labelSingular: zod_1.z.string().min(1).optional(),
    labelPlural: zod_1.z.string().min(1).optional(),
    description: zod_1.z.string().optional(),
    icon: zod_1.z.string().optional(),
    shortcut: zod_1.z.string().optional(),
    isActive: zod_1.z.boolean().optional(),
    isLabelSyncedWithName: zod_1.z.boolean().optional(),
    labelIdentifierFieldMetadataId: zod_1.z.string().uuid().optional(),
    imageIdentifierFieldMetadataId: zod_1.z.string().uuid().optional(),
});
exports.metadataCreateFieldInputSchema = zod_1.z.object({
    objectMetadataId: zod_1.z.string().uuid(),
    type: zod_1.z
        .string()
        .describe('FieldMetadataType — one of TEXT, NUMBER, BOOLEAN, DATE_TIME, DATE, SELECT, MULTI_SELECT, RAW_JSON, RICH_TEXT, RELATION, MORPH_RELATION, EMAILS, PHONES, ADDRESS, LINKS, FULL_NAME, CURRENCY, RATING, FILES, ARRAY, ACTOR, POSITION.'),
    name: zod_1.z.string().min(1).describe('Internal name (camelCase).'),
    label: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    icon: zod_1.z.string().optional(),
    isNullable: zod_1.z.boolean().optional(),
    isUnique: zod_1.z.boolean().optional(),
    defaultValue: zod_1.z.unknown().optional(),
    options: zod_1.z
        .unknown()
        .optional()
        .describe('For SELECT/MULTI_SELECT: array of {position, label, value, color}. Twenty enforces UPPER_SNAKE_CASE on `value`.'),
    settings: zod_1.z.unknown().optional(),
    isLabelSyncedWithName: zod_1.z.boolean().optional(),
});
exports.metadataUpdateFieldInputSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    name: zod_1.z.string().min(1).optional(),
    label: zod_1.z.string().min(1).optional(),
    description: zod_1.z.string().optional(),
    icon: zod_1.z.string().optional(),
    isActive: zod_1.z.boolean().optional(),
    isNullable: zod_1.z.boolean().optional(),
    isUnique: zod_1.z.boolean().optional(),
    defaultValue: zod_1.z.unknown().optional(),
    options: zod_1.z.unknown().optional(),
    settings: zod_1.z.unknown().optional(),
    isLabelSyncedWithName: zod_1.z.boolean().optional(),
});
exports.metadataCreateManyFieldsInputSchema = zod_1.z.object({
    fields: zod_1.z
        .array(exports.metadataCreateFieldInputSchema)
        .min(1)
        .max(20)
        .describe('Array of fields to create on (potentially different) objects. 1-20 items.'),
});
exports.metadataCreateRelationInputSchema = zod_1.z.object({
    objectMetadataId: zod_1.z.string().uuid().describe('Source object id.'),
    name: zod_1.z.string().min(1).describe('Internal name of the relation field (camelCase).'),
    label: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    icon: zod_1.z.string().optional(),
    type: zod_1.z.enum(['MANY_TO_ONE', 'ONE_TO_MANY']),
    targetObjectMetadataId: zod_1.z.string().uuid().describe('Target object id.'),
    targetFieldLabel: zod_1.z.string().min(1).describe('Inverse relation label on the target object.'),
    targetFieldIcon: zod_1.z.string().min(1),
});
exports.metadataGetCallingActorInputSchema = zod_1.z.object({});
// --- Op kind enum (the union of all kinds the dispatcher supports) ---------
//
// Workflows are intentionally NOT here — they go through workflows.ts.
exports.ApplyPlanOpKind = zod_1.z.enum([
    // data-model (Phase 1-3)
    'CREATE_OBJECT',
    'CREATE_FIELD',
    'UPDATE_FIELD',
    'CREATE_RELATION',
    // v1.1 extras
    'UPDATE_OBJECT',
    'BULK_CREATE_FIELD',
    // views (Phase 4)
    'CREATE_VIEW',
    'UPDATE_VIEW',
    'CREATE_VIEW_FIELD',
    'UPDATE_VIEW_FIELD',
    'CREATE_VIEW_FILTER',
    'UPDATE_VIEW_FILTER',
    'CREATE_VIEW_SORT',
    // access (Phase 5)
    'CREATE_ROLE',
    'UPDATE_ROLE',
    'UPSERT_OBJECT_PERMISSION',
    'UPSERT_FIELD_PERMISSION',
    'INVITE_MEMBERS',
    'CREATE_API_KEY',
    'REVOKE_API_KEY',
]);
const ApplyPlanMutation = zod_1.z.object({
    key: zod_1.z
        .string()
        .min(1)
        .describe('Stable client-side idempotency key, unique within the plan.'),
    op: exports.ApplyPlanOpKind,
    args: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).describe('Inner-tool / GraphQL arguments for this op.'),
});
exports.metadataApplyPlanInputSchema = zod_1.z.object({
    mutations: zod_1.z
        .array(ApplyPlanMutation)
        .min(1)
        .max(50)
        .describe('Ordered list of mutations to apply.'),
    resumeFrom: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe('Mutation keys already applied in a previous run — apply_plan skips these. Caller derives this list from SchemaChangeAudit rows with status=APPLIED.'),
    expectedSha256: zod_1.z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe('SHA-256 (lowercase hex) of canonical JSON of the mutations array. apply_plan recomputes and refuses if mismatch — defence in depth against in-transit drift.'),
});
// --- Dispatch table ----------------------------------------------------------
//
// data-model + v1.1 ops live here; view + access ops contributed by sibling
// modules (so each module owns its own routing).
const dataModelDispatch = {
    CREATE_OBJECT: { transport: 'inner_tool', innerToolName: 'create_object_metadata' },
    CREATE_FIELD: { transport: 'inner_tool', innerToolName: 'create_field_metadata' },
    UPDATE_FIELD: { transport: 'inner_tool', innerToolName: 'update_field_metadata' },
    CREATE_RELATION: {
        transport: 'inner_tool',
        innerToolName: 'create_many_relation_fields',
        argsTransform: (args) => ({ relations: [args] }),
    },
    UPDATE_OBJECT: { transport: 'inner_tool', innerToolName: 'update_object_metadata' },
    BULK_CREATE_FIELD: { transport: 'inner_tool', innerToolName: 'create_many_field_metadata' },
};
const APPLY_PLAN_DISPATCH = {
    ...dataModelDispatch,
    ...views_1.viewsDispatchEntries,
    ...access_1.accessDispatchEntries,
};
// --- Helpers -----------------------------------------------------------------
const wrapInExecute = (client, innerName, args) => client.toolsCall('execute_tool', { toolName: innerName, arguments: args });
const wrapGraphqlResult = (data) => ({
    content: [{ type: 'text', text: JSON.stringify({ success: true, result: data }) }],
    isError: false,
});
const QUERY_ROUTES = {
    objects: { transport: 'inner_tool', innerToolName: 'get_object_metadata' },
    fields: { transport: 'inner_tool', innerToolName: 'get_field_metadata' },
    views: { transport: 'inner_tool', innerToolName: 'get_views' },
    view_fields: { transport: 'inner_tool', innerToolName: 'get_view_fields' },
    view_filters: { transport: 'inner_tool', innerToolName: 'get_view_filters' },
    view_sorts: { transport: 'inner_tool', innerToolName: 'get_view_sorts' },
    roles: {
        transport: 'graphql',
        query: 'query { roles { id label description icon canUpdateAllSettings canAccessAllTools canReadAllObjectRecords canUpdateAllObjectRecords canSoftDeleteAllObjectRecords canDestroyAllObjectRecords canBeAssignedToUsers canBeAssignedToAgents canBeAssignedToApiKeys } }',
    },
    api_keys: {
        transport: 'graphql',
        query: 'query { apiKeys { id name expiresAt revokedAt createdAt updatedAt } }',
    },
    webhooks: {
        transport: 'graphql',
        query: 'query { webhooks { id targetUrl operations description } }',
    },
};
/**
 * Canonical JSON for hashing: keys sorted recursively. Same algorithm both
 * sides (orchestrator and apply_plan) must use, so we keep it self-contained.
 */
const canonicalize = (value) => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
};
const sha256OfMutations = (mutations) => (0, node_crypto_1.createHash)('sha256').update(canonicalize(mutations)).digest('hex');
exports.sha256OfMutations = sha256OfMutations;
/**
 * Decode a JWT without verification — we just want to read the claims of OUR
 * own bearer token to expose `apiKeyId` to agents. Twenty's API key tokens
 * carry: `{sub, type: 'API_KEY', workspaceId, iat, exp, jti}`. The `jti` is
 * the api-key id (set via the JWT `jwtid` option in
 * `JwtWrapperService.generateAppSecret`).
 */
const decodeJwtClaims = (jwt) => {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts[1]) {
        throw new Error('not a JWT (expected 3 dot-separated segments)');
    }
    const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '=');
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
};
const wrapApplyPlanResult = (result) => ({
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.failed !== null,
});
// --- Handlers ----------------------------------------------------------------
const buildMetadataHandlers = (client, apiKey) => ({
    metadataQuery: async (args) => {
        const route = QUERY_ROUTES[args.kind];
        if (route.transport === 'inner_tool') {
            return wrapInExecute(client, route.innerToolName, args.args ?? {});
        }
        const data = await client.graphqlMutation(route.query, {});
        return wrapGraphqlResult(data);
    },
    metadataCreateObject: (args) => wrapInExecute(client, 'create_object_metadata', args),
    metadataUpdateObject: (args) => wrapInExecute(client, 'update_object_metadata', args),
    metadataCreateField: (args) => wrapInExecute(client, 'create_field_metadata', args),
    metadataUpdateField: (args) => wrapInExecute(client, 'update_field_metadata', args),
    metadataCreateManyFields: (args) => wrapInExecute(client, 'create_many_field_metadata', args),
    /**
     * `create_many_relation_fields` takes `{relations: [...]}`; we expose a
     * single-relation API at the proxy boundary for clarity. Callers that want
     * batch creation can issue multiple metadata_apply_plan mutations.
     */
    metadataCreateRelation: (args) => wrapInExecute(client, 'create_many_relation_fields', { relations: [args] }),
    /**
     * Returns the calling actor's id and workspace, derived locally by decoding
     * the bearer JWT. No Twenty round-trip — used by the access agent to
     * detect "is this mutation modifying ME?" before sending REVOKE_API_KEY or
     * UPSERT_*_PERMISSION on its own role.
     */
    metadataGetCallingActor: async (_args) => {
        const claims = decodeJwtClaims(apiKey);
        const result = {
            apiKeyId: claims.jti ?? null,
            workspaceId: claims.workspaceId ?? null,
            type: claims.type ?? null,
            issuedAt: typeof claims.iat === 'number' ? new Date(claims.iat * 1000).toISOString() : null,
            expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : null,
        };
        return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }],
            isError: false,
        };
    },
    metadataApplyPlan: async (args) => {
        if (args.expectedSha256) {
            const computed = (0, exports.sha256OfMutations)(args.mutations);
            if (computed !== args.expectedSha256) {
                return wrapApplyPlanResult({
                    totalMutations: args.mutations.length,
                    applied: [],
                    skipped: [],
                    failed: {
                        key: '<plan>',
                        op: 'SHA256_CHECK',
                        error: `expectedSha256 mismatch: got ${computed}, expected ${args.expectedSha256}`,
                    },
                });
            }
        }
        const resumeSet = new Set(args.resumeFrom ?? []);
        const applied = [];
        const skipped = [];
        let failed = null;
        for (const m of args.mutations) {
            if (resumeSet.has(m.key)) {
                skipped.push({ key: m.key, op: m.op, reason: 'in_resume_from' });
                continue;
            }
            const dispatch = APPLY_PLAN_DISPATCH[m.op];
            if (!dispatch) {
                failed = {
                    key: m.key,
                    op: m.op,
                    error: `op ${m.op} has no dispatch entry — supported: ${Object.keys(APPLY_PLAN_DISPATCH).join(', ')}`,
                };
                break;
            }
            try {
                let result;
                if (dispatch.transport === 'inner_tool') {
                    const innerArgs = dispatch.argsTransform
                        ? dispatch.argsTransform(m.args)
                        : m.args;
                    result = await wrapInExecute(client, dispatch.innerToolName, innerArgs);
                }
                else {
                    const { query, variables } = dispatch.build(m.args);
                    const data = await client.graphqlMutation(query, variables);
                    result = wrapGraphqlResult(data);
                }
                applied.push({ key: m.key, op: m.op, result });
            }
            catch (err) {
                failed = {
                    key: m.key,
                    op: m.op,
                    error: err instanceof Error ? err.message : String(err),
                };
                break;
            }
        }
        return wrapApplyPlanResult({
            totalMutations: args.mutations.length,
            applied,
            skipped,
            failed,
        });
    },
});
exports.buildMetadataHandlers = buildMetadataHandlers;
// --- Tool definitions (for server.registerTool) -----------------------------
exports.metadataToolDefinitions = {
    metadata_query: {
        title: 'Read CRM metadata catalog',
        description: 'Read entries from Twenty\'s metadata catalog. Kinds `objects/fields/views/view_fields/view_filters/view_sorts` route to inner tools (read-only). Kinds `roles/api_keys/webhooks` route to GraphQL queries (Twenty exposes those as resolvers only). Pass `kind`; `args` is honoured for inner-tool kinds (e.g. `{id?, objectMetadataId?, limit?}`) and ignored for GraphQL kinds.',
        inputSchema: exports.metadataQueryInputSchema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    },
    metadata_create_object: {
        title: 'Create a custom CRM object',
        description: 'Create a new custom object in the workspace data model. Routes to Twenty\'s `create_object_metadata` inner tool. Use camelCase for nameSingular/namePlural.',
        inputSchema: exports.metadataCreateObjectInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    metadata_update_object: {
        title: 'Update a custom CRM object',
        description: 'Update an existing custom object\'s name, label, icon, or active flag. Routes to Twenty\'s `update_object_metadata` inner tool. Cannot modify standard objects (Twenty rejects).',
        inputSchema: exports.metadataUpdateObjectInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    metadata_create_field: {
        title: 'Create a custom field on a CRM object',
        description: 'Create a custom field on an existing object (standard or custom). Routes to Twenty\'s `create_field_metadata` inner tool. For SELECT/MULTI_SELECT, `options` value must be UPPER_SNAKE_CASE. Twenty silently no-ops on duplicate camelCase names — use search-before-create or rely on resumeFrom + audit lookup for idempotency.',
        inputSchema: exports.metadataCreateFieldInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    metadata_update_field: {
        title: 'Update a custom field',
        description: 'Update a custom field\'s name, label, options, active flag, etc. Routes to Twenty\'s `update_field_metadata` inner tool.',
        inputSchema: exports.metadataUpdateFieldInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    metadata_create_many_fields: {
        title: 'Batch-create custom fields',
        description: 'Create 1-20 custom fields in a single call (potentially across different objects). Routes to Twenty\'s `create_many_field_metadata` inner tool. Useful when bootstrapping a new custom object with several fields.',
        inputSchema: exports.metadataCreateManyFieldsInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    metadata_create_relation: {
        title: 'Create a relation between two CRM objects',
        description: 'Create a single MANY_TO_ONE or ONE_TO_MANY relation field on the source object pointing to the target. Routes to Twenty\'s `create_many_relation_fields` inner tool with a single-relation array.',
        inputSchema: exports.metadataCreateRelationInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    metadata_get_calling_actor: {
        title: 'Identify the calling actor',
        description: 'Returns the apiKeyId and workspaceId of the bearer token currently authenticating the call, derived locally from the JWT (no network round-trip). Used by the access agent to refuse self-modifying mutations (revoke own key, modify own role).',
        inputSchema: exports.metadataGetCallingActorInputSchema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    },
    metadata_apply_plan: {
        title: 'Apply an approved metadata mutation plan',
        description: 'Execute an ordered list of metadata mutations. Designed for the crm-administration pod\'s plan-then-apply flow: caller stores a plan as a Twenty Note, gets user `apply <hash>` confirmation, then calls this with the parsed mutations array, the SHA-256 it computed, and a `resumeFrom` list of mutation keys already applied per SchemaChangeAudit. Stops on first failure and returns per-mutation status. NOT atomic — Twenty does not roll back partial applies. Supported op kinds: data-model (CREATE_OBJECT/CREATE_FIELD/UPDATE_FIELD/CREATE_RELATION/UPDATE_OBJECT/BULK_CREATE_FIELD), views (CREATE_VIEW/UPDATE_VIEW/CREATE_VIEW_FIELD/UPDATE_VIEW_FIELD/CREATE_VIEW_FILTER/UPDATE_VIEW_FILTER/CREATE_VIEW_SORT), access (CREATE_ROLE/UPDATE_ROLE/UPSERT_OBJECT_PERMISSION/UPSERT_FIELD_PERMISSION/INVITE_MEMBERS/CREATE_API_KEY/REVOKE_API_KEY). Workflows are NOT in this dispatcher — use the workflow_* tools.',
        inputSchema: exports.metadataApplyPlanInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
};
//# sourceMappingURL=metadata.js.map