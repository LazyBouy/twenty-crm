"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metadataToolDefinitions = exports.buildMetadataHandlers = exports.sha256OfMutations = exports.metadataApplyPlanInputSchema = exports.metadataCreateRelationInputSchema = exports.metadataCreateFieldInputSchema = exports.metadataCreateObjectInputSchema = exports.metadataQueryInputSchema = void 0;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
/**
 * Twenty's in-tree MCP catalog already exposes a comprehensive set of
 * metadata tools (see `packages/twenty-server/src/engine/metadata-modules/<x>/tools/*.factory.ts`).
 * They are reachable through the standard `execute_tool` JSON-RPC entry, but
 * by surfacing typed proxy tools we get:
 *   1. Clean tool names in `discovery({})` output (no `execute_tool({toolName: …})` boilerplate).
 *   2. Zod-validated inputs at the proxy boundary, which catches agent mistakes early.
 *   3. A place to host higher-level workflows like `metadata_apply_plan` that
 *      Twenty does not provide natively.
 *
 * All tools added here are GATED behind the `TWENTY_MCP_ENABLE_METADATA=true`
 * env flag. When the flag is unset (default), the tools are not registered —
 * agents see only the existing CRM + discovery surface. This keeps the patch
 * reversible without redeploying.
 */
// --- Input schemas (mirror Twenty's inner-tool schemas) ---------------------
const MetadataQueryKind = zod_1.z.enum([
    'objects',
    'fields',
    'views',
    'view_fields',
    'view_filters',
    'view_sorts',
]);
exports.metadataQueryInputSchema = zod_1.z.object({
    kind: MetadataQueryKind.describe('Which metadata catalog to read. Routes to Twenty\'s `get_<kind>_metadata` / `get_<kind>` tool.'),
    args: zod_1.z
        .record(zod_1.z.string(), zod_1.z.unknown())
        .optional()
        .describe('Inner-tool arguments — typically `{id?, objectMetadataId?, limit?}` for fields, etc. See Twenty\'s tool factory for the exact shape.'),
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
const ApplyPlanOpKind = zod_1.z.enum([
    'CREATE_OBJECT',
    'CREATE_FIELD',
    'UPDATE_FIELD',
    'CREATE_RELATION',
]);
const ApplyPlanMutation = zod_1.z.object({
    key: zod_1.z
        .string()
        .min(1)
        .describe('Stable client-side idempotency key, unique within the plan.'),
    op: ApplyPlanOpKind,
    args: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).describe('Inner-tool arguments for this op.'),
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
// --- Helpers -----------------------------------------------------------------
const wrapInExecute = (client, innerName, args) => client.toolsCall('execute_tool', { toolName: innerName, arguments: args });
const QUERY_INNER_TOOL = {
    objects: 'get_object_metadata',
    fields: 'get_field_metadata',
    views: 'get_views',
    view_fields: 'get_view_fields',
    view_filters: 'get_view_filters',
    view_sorts: 'get_view_sorts',
};
const APPLY_PLAN_INNER_TOOL = {
    CREATE_OBJECT: 'create_object_metadata',
    CREATE_FIELD: 'create_field_metadata',
    UPDATE_FIELD: 'update_field_metadata',
    CREATE_RELATION: 'create_many_relation_fields',
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
const wrapApplyPlanResult = (result) => ({
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.failed !== null,
});
// --- Handlers ----------------------------------------------------------------
const buildMetadataHandlers = (client) => ({
    metadataQuery: (args) => wrapInExecute(client, QUERY_INNER_TOOL[args.kind], args.args ?? {}),
    metadataCreateObject: (args) => wrapInExecute(client, 'create_object_metadata', args),
    metadataCreateField: (args) => wrapInExecute(client, 'create_field_metadata', args),
    /**
     * `create_many_relation_fields` takes `{relations: [...]}`; we expose a
     * single-relation API at the proxy boundary for clarity. Callers that want
     * batch creation can issue multiple metadata_apply_plan mutations.
     */
    metadataCreateRelation: (args) => wrapInExecute(client, 'create_many_relation_fields', { relations: [args] }),
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
            const innerTool = APPLY_PLAN_INNER_TOOL[m.op];
            const innerArgs = m.op === 'CREATE_RELATION'
                ? { relations: [m.args] }
                : m.args;
            try {
                const result = await wrapInExecute(client, innerTool, innerArgs);
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
        description: 'Read entries from Twenty\'s metadata catalog (objects, fields, views, view-fields, view-filters, view-sorts). Read-only. Routes to Twenty\'s `get_<kind>_metadata` / `get_<kind>` inner tool. Pass `kind` plus optional `args` like `{id?, objectMetadataId?, limit?}`.',
        inputSchema: exports.metadataQueryInputSchema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    },
    metadata_create_object: {
        title: 'Create a custom CRM object',
        description: 'Create a new custom object in the workspace data model. Routes to Twenty\'s `create_object_metadata` inner tool. Use camelCase for nameSingular/namePlural; UPPER_SNAKE_CASE applies to SELECT field option values added subsequently.',
        inputSchema: exports.metadataCreateObjectInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    metadata_create_field: {
        title: 'Create a custom field on a CRM object',
        description: 'Create a custom field on an existing object (standard or custom). Routes to Twenty\'s `create_field_metadata` inner tool. For SELECT/MULTI_SELECT, `options` value must be UPPER_SNAKE_CASE.',
        inputSchema: exports.metadataCreateFieldInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    metadata_create_relation: {
        title: 'Create a relation between two CRM objects',
        description: 'Create a single MANY_TO_ONE or ONE_TO_MANY relation field on the source object pointing to the target. Routes to Twenty\'s `create_many_relation_fields` inner tool with a single-relation array.',
        inputSchema: exports.metadataCreateRelationInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    metadata_apply_plan: {
        title: 'Apply an approved metadata mutation plan',
        description: 'Execute an ordered list of metadata mutations. Designed for the crm-administration pod\'s plan-then-apply flow: caller stores a plan as a Twenty Note, gets user `apply <hash>` confirmation, then calls this with the parsed mutations array, the SHA-256 it computed, and a `resumeFrom` list of mutation keys already applied per SchemaChangeAudit. Stops on first failure and returns per-mutation status. NOT atomic — Twenty does not roll back partial applies.',
        inputSchema: exports.metadataApplyPlanInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
};
//# sourceMappingURL=metadata.js.map