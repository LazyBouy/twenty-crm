import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';

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

const MetadataQueryKind = z.enum([
  'objects',
  'fields',
  'views',
  'view_fields',
  'view_filters',
  'view_sorts',
]);

export const metadataQueryInputSchema = z.object({
  kind: MetadataQueryKind.describe(
    'Which metadata catalog to read. Routes to Twenty\'s `get_<kind>_metadata` / `get_<kind>` tool.',
  ),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Inner-tool arguments — typically `{id?, objectMetadataId?, limit?}` for fields, etc. See Twenty\'s tool factory for the exact shape.',
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

const ApplyPlanOpKind = z.enum([
  'CREATE_OBJECT',
  'CREATE_FIELD',
  'UPDATE_FIELD',
  'CREATE_RELATION',
]);

const ApplyPlanMutation = z.object({
  key: z
    .string()
    .min(1)
    .describe('Stable client-side idempotency key, unique within the plan.'),
  op: ApplyPlanOpKind,
  args: z.record(z.string(), z.unknown()).describe('Inner-tool arguments for this op.'),
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

// --- Helpers -----------------------------------------------------------------

const wrapInExecute = (
  client: TwentyMcpClient,
  innerName: string,
  args: Record<string, unknown>,
): Promise<ToolsCallResult> =>
  client.toolsCall('execute_tool', { toolName: innerName, arguments: args });

const QUERY_INNER_TOOL: Record<z.infer<typeof MetadataQueryKind>, string> = {
  objects: 'get_object_metadata',
  fields: 'get_field_metadata',
  views: 'get_views',
  view_fields: 'get_view_fields',
  view_filters: 'get_view_filters',
  view_sorts: 'get_view_sorts',
};

const APPLY_PLAN_INNER_TOOL: Record<z.infer<typeof ApplyPlanOpKind>, string> = {
  CREATE_OBJECT: 'create_object_metadata',
  CREATE_FIELD: 'create_field_metadata',
  UPDATE_FIELD: 'update_field_metadata',
  CREATE_RELATION: 'create_many_relation_fields',
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

export const buildMetadataHandlers = (client: TwentyMcpClient) => ({
  metadataQuery: (args: z.infer<typeof metadataQueryInputSchema>) =>
    wrapInExecute(client, QUERY_INNER_TOOL[args.kind], args.args ?? {}),

  metadataCreateObject: (args: z.infer<typeof metadataCreateObjectInputSchema>) =>
    wrapInExecute(client, 'create_object_metadata', args),

  metadataCreateField: (args: z.infer<typeof metadataCreateFieldInputSchema>) =>
    wrapInExecute(client, 'create_field_metadata', args),

  /**
   * `create_many_relation_fields` takes `{relations: [...]}`; we expose a
   * single-relation API at the proxy boundary for clarity. Callers that want
   * batch creation can issue multiple metadata_apply_plan mutations.
   */
  metadataCreateRelation: (args: z.infer<typeof metadataCreateRelationInputSchema>) =>
    wrapInExecute(client, 'create_many_relation_fields', { relations: [args] }),

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
      const innerTool = APPLY_PLAN_INNER_TOOL[m.op];
      const innerArgs =
        m.op === 'CREATE_RELATION'
          ? { relations: [m.args] }
          : (m.args as Record<string, unknown>);
      try {
        const result = await wrapInExecute(client, innerTool, innerArgs);
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
      'Read entries from Twenty\'s metadata catalog (objects, fields, views, view-fields, view-filters, view-sorts). Read-only. Routes to Twenty\'s `get_<kind>_metadata` / `get_<kind>` inner tool. Pass `kind` plus optional `args` like `{id?, objectMetadataId?, limit?}`.',
    inputSchema: metadataQueryInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  metadata_create_object: {
    title: 'Create a custom CRM object',
    description:
      'Create a new custom object in the workspace data model. Routes to Twenty\'s `create_object_metadata` inner tool. Use camelCase for nameSingular/namePlural; UPPER_SNAKE_CASE applies to SELECT field option values added subsequently.',
    inputSchema: metadataCreateObjectInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_create_field: {
    title: 'Create a custom field on a CRM object',
    description:
      'Create a custom field on an existing object (standard or custom). Routes to Twenty\'s `create_field_metadata` inner tool. For SELECT/MULTI_SELECT, `options` value must be UPPER_SNAKE_CASE.',
    inputSchema: metadataCreateFieldInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_create_relation: {
    title: 'Create a relation between two CRM objects',
    description:
      'Create a single MANY_TO_ONE or ONE_TO_MANY relation field on the source object pointing to the target. Routes to Twenty\'s `create_many_relation_fields` inner tool with a single-relation array.',
    inputSchema: metadataCreateRelationInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_apply_plan: {
    title: 'Apply an approved metadata mutation plan',
    description:
      'Execute an ordered list of metadata mutations. Designed for the crm-administration pod\'s plan-then-apply flow: caller stores a plan as a Twenty Note, gets user `apply <hash>` confirmation, then calls this with the parsed mutations array, the SHA-256 it computed, and a `resumeFrom` list of mutation keys already applied per SchemaChangeAudit. Stops on first failure and returns per-mutation status. NOT atomic — Twenty does not roll back partial applies.',
    inputSchema: metadataApplyPlanInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
} as const;
