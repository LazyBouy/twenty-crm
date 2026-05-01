import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';
import { accessDispatchEntries } from './access';
import { viewsDispatchEntries } from './views';

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
 *
 * Phase 4 expansion: dispatch table now supports two transports (inner_tool
 * via execute_tool, and graphql via /metadata GraphQL) so it can route view
 * ops (inner-tool) and access ops (GraphQL — Twenty exposes those as
 * resolvers only). Workflows are NOT in this dispatcher; the workflow agent
 * calls workflow-specific typed tools in workflows.ts directly.
 */

// --- Shared types ------------------------------------------------------------

export type InnerToolDispatch = {
  transport: 'inner_tool';
  innerToolName: string;
  /** Optional reshape applied before dispatch — used by CREATE_RELATION. */
  argsTransform?: (args: Record<string, unknown>) => Record<string, unknown>;
};

export type GraphqlDispatch = {
  transport: 'graphql';
  /** Returns the GraphQL document string + the variables map for the call. */
  build: (args: Record<string, unknown>) => {
    query: string;
    variables: Record<string, unknown>;
  };
};

export type DispatchEntry = InnerToolDispatch | GraphqlDispatch;

// --- Input schemas (mirror Twenty's inner-tool schemas) ---------------------

const MetadataQueryKind = z.enum([
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

export const metadataQueryInputSchema = z.object({
  kind: MetadataQueryKind.describe(
    'Which metadata catalog to read. `objects/fields/views/view_*` route to inner tools; `roles/api_keys/webhooks` route to GraphQL queries since Twenty does not expose them as inner tools.',
  ),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Inner-tool arguments — typically `{id?, objectMetadataId?, limit?}` for fields, etc. Ignored for GraphQL kinds (roles/api_keys/webhooks); they always return the full list.',
    ),
});

export const metadataCreateObjectInputSchema = z.object({
  nameSingular: z
    .string()
    .min(1)
    .describe('Singular camelCase name (e.g. "schemaChangeAudit").'),
  namePlural: z
    .string()
    .min(1)
    .describe('Plural camelCase name (e.g. "schemaChangeAudits").'),
  labelSingular: z.string().min(1).describe('Display label, singular.'),
  labelPlural: z.string().min(1).describe('Display label, plural.'),
  description: z.string().optional(),
  icon: z.string().optional().describe('e.g. "IconHistory" — see Twenty\'s icon set.'),
  shortcut: z.string().optional(),
  isRemote: z.boolean().optional(),
  isLabelSyncedWithName: z.boolean().optional(),
});

export const metadataUpdateObjectInputSchema = z.object({
  id: z.string().uuid(),
  nameSingular: z.string().min(1).optional(),
  namePlural: z.string().min(1).optional(),
  labelSingular: z.string().min(1).optional(),
  labelPlural: z.string().min(1).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  shortcut: z.string().optional(),
  isActive: z.boolean().optional(),
  isLabelSyncedWithName: z.boolean().optional(),
  labelIdentifierFieldMetadataId: z.string().uuid().optional(),
  imageIdentifierFieldMetadataId: z.string().uuid().optional(),
});

export const metadataCreateFieldInputSchema = z.object({
  objectMetadataId: z.string().uuid(),
  type: z
    .string()
    .describe(
      'FieldMetadataType — one of TEXT, NUMBER, BOOLEAN, DATE_TIME, DATE, SELECT, MULTI_SELECT, RAW_JSON, RICH_TEXT, RELATION, MORPH_RELATION, EMAILS, PHONES, ADDRESS, LINKS, FULL_NAME, CURRENCY, RATING, FILES, ARRAY, ACTOR, POSITION.',
    ),
  name: z.string().min(1).describe('Internal name (camelCase).'),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  isNullable: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  options: z
    .unknown()
    .optional()
    .describe(
      'For SELECT/MULTI_SELECT: array of {position, label, value, color}. Twenty enforces UPPER_SNAKE_CASE on `value`.',
    ),
  settings: z.unknown().optional(),
  isLabelSyncedWithName: z.boolean().optional(),
});

export const metadataUpdateFieldInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  isActive: z.boolean().optional(),
  isNullable: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  options: z.unknown().optional(),
  settings: z.unknown().optional(),
  isLabelSyncedWithName: z.boolean().optional(),
});

export const metadataCreateManyFieldsInputSchema = z.object({
  fields: z
    .array(metadataCreateFieldInputSchema)
    .min(1)
    .max(20)
    .describe('Array of fields to create on (potentially different) objects. 1-20 items.'),
});

export const metadataCreateRelationInputSchema = z.object({
  objectMetadataId: z.string().uuid().describe('Source object id.'),
  name: z.string().min(1).describe('Internal name of the relation field (camelCase).'),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  type: z.enum(['MANY_TO_ONE', 'ONE_TO_MANY']),
  targetObjectMetadataId: z.string().uuid().describe('Target object id.'),
  targetFieldLabel: z.string().min(1).describe('Inverse relation label on the target object.'),
  targetFieldIcon: z.string().min(1),
});

export const metadataGetCallingActorInputSchema = z.object({});

// --- Op kind enum (the union of all kinds the dispatcher supports) ---------
//
// Workflows are intentionally NOT here — they go through workflows.ts.

export const ApplyPlanOpKind = z.enum([
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

const ApplyPlanMutation = z.object({
  key: z
    .string()
    .min(1)
    .describe('Stable client-side idempotency key, unique within the plan.'),
  op: ApplyPlanOpKind,
  args: z.record(z.string(), z.unknown()).describe('Inner-tool / GraphQL arguments for this op.'),
});

export const metadataApplyPlanInputSchema = z.object({
  mutations: z
    .array(ApplyPlanMutation)
    .min(1)
    .max(50)
    .describe('Ordered list of mutations to apply.'),
  resumeFrom: z
    .array(z.string())
    .optional()
    .describe(
      'Mutation keys already applied in a previous run — apply_plan skips these. Caller derives this list from SchemaChangeAudit rows with status=APPLIED.',
    ),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe(
      'SHA-256 (lowercase hex) of canonical JSON of the mutations array. apply_plan recomputes and refuses if mismatch — defence in depth against in-transit drift.',
    ),
});

// --- Dispatch table ----------------------------------------------------------
//
// data-model + v1.1 ops live here; view + access ops contributed by sibling
// modules (so each module owns its own routing).

const dataModelDispatch: Record<string, DispatchEntry> = {
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

const APPLY_PLAN_DISPATCH: Record<string, DispatchEntry> = {
  ...dataModelDispatch,
  ...viewsDispatchEntries,
  ...accessDispatchEntries,
};

// --- Helpers -----------------------------------------------------------------

const wrapInExecute = (
  client: TwentyMcpClient,
  innerName: string,
  args: Record<string, unknown>,
): Promise<ToolsCallResult> =>
  client.toolsCall('execute_tool', { toolName: innerName, arguments: args });

const wrapGraphqlResult = (data: unknown): ToolsCallResult => ({
  content: [{ type: 'text', text: JSON.stringify({ success: true, result: data }) }],
  isError: false,
});

// Routes for `metadata_query` — read-only catalog access.
type QueryRoute =
  | { transport: 'inner_tool'; innerToolName: string }
  | { transport: 'graphql'; query: string };

const QUERY_ROUTES: Record<z.infer<typeof MetadataQueryKind>, QueryRoute> = {
  objects: { transport: 'inner_tool', innerToolName: 'get_object_metadata' },
  fields: { transport: 'inner_tool', innerToolName: 'get_field_metadata' },
  views: { transport: 'inner_tool', innerToolName: 'get_views' },
  view_fields: { transport: 'inner_tool', innerToolName: 'get_view_fields' },
  view_filters: { transport: 'inner_tool', innerToolName: 'get_view_filters' },
  view_sorts: { transport: 'inner_tool', innerToolName: 'get_view_sorts' },
  roles: {
    transport: 'graphql',
    query:
      'query { roles { id label description icon canUpdateAllSettings canAccessAllTools canReadAllObjectRecords canUpdateAllObjectRecords canSoftDeleteAllObjectRecords canDestroyAllObjectRecords canBeAssignedToUsers canBeAssignedToAgents canBeAssignedToApiKeys } }',
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
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();

  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
};

export const sha256OfMutations = (mutations: unknown): string =>
  createHash('sha256').update(canonicalize(mutations)).digest('hex');

/**
 * Decode a JWT without verification — we just want to read the claims of OUR
 * own bearer token to expose `apiKeyId` to agents. Twenty's API key tokens
 * carry: `{sub, type: 'API_KEY', workspaceId, iat, exp, jti}`. The `jti` is
 * the api-key id (set via the JWT `jwtid` option in
 * `JwtWrapperService.generateAppSecret`).
 */
const decodeJwtClaims = (jwt: string): Record<string, unknown> => {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('not a JWT (expected 3 dot-separated segments)');
  }
  const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '=');
  const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  return JSON.parse(json) as Record<string, unknown>;
};

// --- Apply-plan result type --------------------------------------------------

export type ApplyPlanResult = {
  totalMutations: number;
  applied: { key: string; op: string; result: ToolsCallResult }[];
  skipped: { key: string; op: string; reason: 'in_resume_from' }[];
  failed: { key: string; op: string; error: string } | null;
};

const wrapApplyPlanResult = (result: ApplyPlanResult): ToolsCallResult => ({
  content: [{ type: 'text', text: JSON.stringify(result) }],
  isError: result.failed !== null,
});

// --- Handlers ----------------------------------------------------------------

export const buildMetadataHandlers = (
  client: TwentyMcpClient,
  apiKey: string,
) => ({
  metadataQuery: async (args: z.infer<typeof metadataQueryInputSchema>): Promise<ToolsCallResult> => {
    const route = QUERY_ROUTES[args.kind];
    if (route.transport === 'inner_tool') {
      return wrapInExecute(client, route.innerToolName, args.args ?? {});
    }
    const data = await client.graphqlMutation(route.query, {});

    return wrapGraphqlResult(data);
  },

  metadataCreateObject: (args: z.infer<typeof metadataCreateObjectInputSchema>) =>
    wrapInExecute(client, 'create_object_metadata', args),

  metadataUpdateObject: (args: z.infer<typeof metadataUpdateObjectInputSchema>) =>
    wrapInExecute(client, 'update_object_metadata', args),

  metadataCreateField: (args: z.infer<typeof metadataCreateFieldInputSchema>) =>
    wrapInExecute(client, 'create_field_metadata', args),

  metadataUpdateField: (args: z.infer<typeof metadataUpdateFieldInputSchema>) =>
    wrapInExecute(client, 'update_field_metadata', args),

  metadataCreateManyFields: (args: z.infer<typeof metadataCreateManyFieldsInputSchema>) =>
    wrapInExecute(client, 'create_many_field_metadata', args),

  /**
   * `create_many_relation_fields` takes `{relations: [...]}`; we expose a
   * single-relation API at the proxy boundary for clarity. Callers that want
   * batch creation can issue multiple metadata_apply_plan mutations.
   */
  metadataCreateRelation: (args: z.infer<typeof metadataCreateRelationInputSchema>) =>
    wrapInExecute(client, 'create_many_relation_fields', { relations: [args] }),

  /**
   * Returns the calling actor's id and workspace, derived locally by decoding
   * the bearer JWT. No Twenty round-trip — used by the access agent to
   * detect "is this mutation modifying ME?" before sending REVOKE_API_KEY or
   * UPSERT_*_PERMISSION on its own role.
   */
  metadataGetCallingActor: async (
    _args: z.infer<typeof metadataGetCallingActorInputSchema>,
  ): Promise<ToolsCallResult> => {
    const claims = decodeJwtClaims(apiKey);
    const result = {
      apiKeyId: claims.jti ?? null,
      workspaceId: claims.workspaceId ?? null,
      type: claims.type ?? null,
      issuedAt:
        typeof claims.iat === 'number' ? new Date(claims.iat * 1000).toISOString() : null,
      expiresAt:
        typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : null,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }],
      isError: false,
    };
  },

  metadataApplyPlan: async (
    args: z.infer<typeof metadataApplyPlanInputSchema>,
  ): Promise<ToolsCallResult> => {
    if (args.expectedSha256) {
      const computed = sha256OfMutations(args.mutations);
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
    const applied: ApplyPlanResult['applied'] = [];
    const skipped: ApplyPlanResult['skipped'] = [];
    let failed: ApplyPlanResult['failed'] = null;

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
        let result: ToolsCallResult;
        if (dispatch.transport === 'inner_tool') {
          const innerArgs = dispatch.argsTransform
            ? dispatch.argsTransform(m.args as Record<string, unknown>)
            : (m.args as Record<string, unknown>);
          result = await wrapInExecute(client, dispatch.innerToolName, innerArgs);
        } else {
          const { query, variables } = dispatch.build(m.args as Record<string, unknown>);
          const data = await client.graphqlMutation(query, variables);
          result = wrapGraphqlResult(data);
        }
        applied.push({ key: m.key, op: m.op, result });
      } catch (err) {
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

// --- Tool definitions (for server.registerTool) -----------------------------

export const metadataToolDefinitions = {
  metadata_query: {
    title: 'Read CRM metadata catalog',
    description:
      'Read entries from Twenty\'s metadata catalog. Kinds `objects/fields/views/view_fields/view_filters/view_sorts` route to inner tools (read-only). Kinds `roles/api_keys/webhooks` route to GraphQL queries (Twenty exposes those as resolvers only). Pass `kind`; `args` is honoured for inner-tool kinds (e.g. `{id?, objectMetadataId?, limit?}`) and ignored for GraphQL kinds.',
    inputSchema: metadataQueryInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  metadata_create_object: {
    title: 'Create a custom CRM object',
    description:
      'Create a new custom object in the workspace data model. Routes to Twenty\'s `create_object_metadata` inner tool. Use camelCase for nameSingular/namePlural.',
    inputSchema: metadataCreateObjectInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_update_object: {
    title: 'Update a custom CRM object',
    description:
      'Update an existing custom object\'s name, label, icon, or active flag. Routes to Twenty\'s `update_object_metadata` inner tool. Cannot modify standard objects (Twenty rejects).',
    inputSchema: metadataUpdateObjectInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  metadata_create_field: {
    title: 'Create a custom field on a CRM object',
    description:
      'Create a custom field on an existing object (standard or custom). Routes to Twenty\'s `create_field_metadata` inner tool. For SELECT/MULTI_SELECT, `options` value must be UPPER_SNAKE_CASE. Twenty silently no-ops on duplicate camelCase names — use search-before-create or rely on resumeFrom + audit lookup for idempotency.',
    inputSchema: metadataCreateFieldInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_update_field: {
    title: 'Update a custom field',
    description:
      'Update a custom field\'s name, label, options, active flag, etc. Routes to Twenty\'s `update_field_metadata` inner tool.',
    inputSchema: metadataUpdateFieldInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  metadata_create_many_fields: {
    title: 'Batch-create custom fields',
    description:
      'Create 1-20 custom fields in a single call (potentially across different objects). Routes to Twenty\'s `create_many_field_metadata` inner tool. Useful when bootstrapping a new custom object with several fields.',
    inputSchema: metadataCreateManyFieldsInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_create_relation: {
    title: 'Create a relation between two CRM objects',
    description:
      'Create a single MANY_TO_ONE or ONE_TO_MANY relation field on the source object pointing to the target. Routes to Twenty\'s `create_many_relation_fields` inner tool with a single-relation array.',
    inputSchema: metadataCreateRelationInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_get_calling_actor: {
    title: 'Identify the calling actor',
    description:
      'Returns the apiKeyId and workspaceId of the bearer token currently authenticating the call, derived locally from the JWT (no network round-trip). Used by the access agent to refuse self-modifying mutations (revoke own key, modify own role).',
    inputSchema: metadataGetCallingActorInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  metadata_apply_plan: {
    title: 'Apply an approved metadata mutation plan',
    description:
      'Execute an ordered list of metadata mutations. Designed for the crm-administration pod\'s plan-then-apply flow: caller stores a plan as a Twenty Note, gets user `apply <hash>` confirmation, then calls this with the parsed mutations array, the SHA-256 it computed, and a `resumeFrom` list of mutation keys already applied per SchemaChangeAudit. Stops on first failure and returns per-mutation status. NOT atomic — Twenty does not roll back partial applies. Supported op kinds: data-model (CREATE_OBJECT/CREATE_FIELD/UPDATE_FIELD/CREATE_RELATION/UPDATE_OBJECT/BULK_CREATE_FIELD), views (CREATE_VIEW/UPDATE_VIEW/CREATE_VIEW_FIELD/UPDATE_VIEW_FIELD/CREATE_VIEW_FILTER/UPDATE_VIEW_FILTER/CREATE_VIEW_SORT), access (CREATE_ROLE/UPDATE_ROLE/UPSERT_OBJECT_PERMISSION/UPSERT_FIELD_PERMISSION/INVITE_MEMBERS/CREATE_API_KEY/REVOKE_API_KEY). Workflows are NOT in this dispatcher — use the workflow_* tools.',
    inputSchema: metadataApplyPlanInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
} as const;
