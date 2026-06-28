import { z } from 'zod';

import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';
import type { DispatchEntry } from './metadata';

/**
 * View-management tools: views, view fields, view filters, view sorts.
 *
 * All routed through Twenty's `execute_tool` inner-tool path — the views
 * factory in
 * `packages/twenty-server/src/engine/metadata-modules/{view,view-field,view-filter,view-sort}/tools/*.factory.ts`
 * provides typed inner tools that the proxy wraps directly.
 *
 * Two important Twenty quirks (verified by reading the factories):
 *
 * 1. **`create_view` takes `objectNameSingular` (humanised), NOT
 *    `objectMetadataId`.** The factory resolves the human name internally via
 *    the metadata cache. Other view tools take UUIDs (viewId, fieldMetadataId).
 *
 * 2. **`visibility` defaults to WORKSPACE.** Agents who want a per-user (private)
 *    view MUST explicitly pass `visibility: UNLISTED`. The proxy's Zod schema
 *    accepts both values without a default to force the agent to choose.
 *
 * Update inner tools (`update_view`, `update_view_field`, `update_view_filter`,
 * `update_view_sort`) all take FLAT input shapes — no `{id, update: {...}}`
 * wrapping (verified by reading the factories). The dispatcher passes args
 * through unchanged.
 */

// --- Operand-per-field-type matrix -------------------------------------------
//
// Ground truth: packages/twenty-front/src/modules/object-record/record-filter/utils/getRecordFilterOperands.ts
// (`FILTER_OPERANDS_MAP` const). This local copy MUST be byte-for-byte identical.
// A coverage test (`views-coverage.test.ts`) parses that source file at test
// time and asserts deep equality with this const, so drift fails CI.
//
// Usage: when a view filter is created or updated with an operand, the wrapper
// calls assertOperandCompatible() before forwarding to Twenty. An invalid
// operand is rejected with isError:true before anything reaches Twenty.

export const FIELD_TYPE_OPERAND_MAP: Record<string, readonly string[]> = {
  TEXT: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  EMAILS: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  FULL_NAME: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  ADDRESS: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  LINKS: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  PHONES: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  CURRENCY: [
    'GREATER_THAN_OR_EQUAL',
    'LESS_THAN_OR_EQUAL',
    'IS_EMPTY',
    'IS_NOT_EMPTY',
  ],
  NUMBER: [
    'IS',
    'IS_NOT',
    'GREATER_THAN_OR_EQUAL',
    'LESS_THAN_OR_EQUAL',
    'IS_EMPTY',
    'IS_NOT_EMPTY',
  ],
  RAW_JSON: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  FILES: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  DATE_TIME: [
    'IS',
    'IS_RELATIVE',
    'IS_IN_PAST',
    'IS_IN_FUTURE',
    'IS_TODAY',
    'IS_BEFORE',
    'IS_AFTER',
    'IS_EMPTY',
    'IS_NOT_EMPTY',
  ],
  DATE: [
    'IS',
    'IS_RELATIVE',
    'IS_IN_PAST',
    'IS_IN_FUTURE',
    'IS_TODAY',
    'IS_BEFORE',
    'IS_AFTER',
    'IS_EMPTY',
    'IS_NOT_EMPTY',
  ],
  RATING: [
    'IS',
    'GREATER_THAN_OR_EQUAL',
    'LESS_THAN_OR_EQUAL',
    'IS_EMPTY',
    'IS_NOT_EMPTY',
  ],
  RELATION: ['IS', 'IS_NOT', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  MULTI_SELECT: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  SELECT: ['IS', 'IS_NOT', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  ACTOR: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  ARRAY: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  BOOLEAN: ['IS'],
  TS_VECTOR: ['VECTOR_SEARCH'],
  UUID: ['IS'],
};

// Readable description of the matrix for tool descriptions (LLM-facing).
const OPERAND_MATRIX_DESCRIPTION = `\
Valid operand by field type (enforced at runtime — invalid combos are rejected):
- TEXT / EMAILS / FULL_NAME / ADDRESS / LINKS / PHONES / RAW_JSON / FILES / MULTI_SELECT / ACTOR / ARRAY: CONTAINS, DOES_NOT_CONTAIN, IS_EMPTY, IS_NOT_EMPTY
- CURRENCY: GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL, IS_EMPTY, IS_NOT_EMPTY
- NUMBER: IS, IS_NOT, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL, IS_EMPTY, IS_NOT_EMPTY
- DATE_TIME / DATE: IS, IS_RELATIVE, IS_IN_PAST, IS_IN_FUTURE, IS_TODAY, IS_BEFORE, IS_AFTER, IS_EMPTY, IS_NOT_EMPTY
- RATING: IS, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL, IS_EMPTY, IS_NOT_EMPTY
- RELATION: IS, IS_NOT, IS_EMPTY, IS_NOT_EMPTY
- SELECT: IS, IS_NOT, IS_EMPTY, IS_NOT_EMPTY
- BOOLEAN: IS
- TS_VECTOR: VECTOR_SEARCH
- UUID: IS`;

// --- assertOperandCompatible helper ------------------------------------------
//
// Exported so metadata.ts apply_plan dispatcher can call the same function
// (Layer 2 symmetry — both layers call the same check, no drift).

type AssertResult =
  | { valid: true; fieldType?: string; unknownType?: boolean }
  | { valid: false; error: string };

export const assertOperandCompatible = async (
  client: TwentyMcpClient,
  fieldMetadataId: string,
  operand: string,
): Promise<AssertResult> => {
  // Step 1: look up the field's type via get_field_metadata.
  // Twenty returns Entity[] (TypeOrmQueryService.query always returns an array).
  const result = await client.toolsCall('execute_tool', {
    toolName: 'get_field_metadata',
    arguments: { id: fieldMetadataId },
  });

  const text = (
    result.content[0] as { type: string; text?: string } | undefined
  )?.text;
  if (!text) {
    return {
      valid: false,
      error: `field metadata lookup returned no text block for fieldMetadataId ${fieldMetadataId}`,
    };
  }

  let parsed: Array<{ type?: string; id?: string }>;
  try {
    parsed = JSON.parse(text) as Array<{ type?: string; id?: string }>;
  } catch {
    return {
      valid: false,
      error: `field metadata lookup returned non-JSON for fieldMetadataId ${fieldMetadataId}`,
    };
  }

  // FAIL CLOSED: empty array means the field wasn't found.
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      valid: false,
      error: `field metadata lookup returned no rows for fieldMetadataId ${fieldMetadataId}`,
    };
  }

  const fieldType = parsed[0]?.type;
  if (!fieldType) {
    return {
      valid: false,
      error: `field metadata lookup returned a row with no type for fieldMetadataId ${fieldMetadataId}`,
    };
  }

  const allowedOperands = FIELD_TYPE_OPERAND_MAP[fieldType];
  if (allowedOperands === undefined) {
    // Unknown type — fail open with a warning so new Twenty field types don't break callers.
    // This is the ONLY fail-open path. The matrix coverage test ensures all KNOWN types are
    // validated; this only fires for genuinely new field types not yet in twenty-front.
    console.warn(
      `[assertOperandCompatible] unknown field type "${fieldType}" for fieldMetadataId ${fieldMetadataId} — failing open (no validation). ` +
        `Update FIELD_TYPE_OPERAND_MAP in views.ts to add coverage for this type.`,
    );

    return { valid: true, unknownType: true };
  }

  if (!allowedOperands.includes(operand)) {
    return {
      valid: false,
      error: `Operand ${operand} is not valid for ${fieldType} field (id: ${fieldMetadataId}). Valid operands: ${allowedOperands.join(', ')}.`,
    };
  }

  return { valid: true, fieldType };
};

// --- Shared sub-schemas ------------------------------------------------------

const ViewType = z.enum(['TABLE', 'KANBAN', 'CALENDAR']);

const ViewVisibility = z.enum(['WORKSPACE', 'UNLISTED']);

const KanbanAggregateOperation = z.enum([
  'MIN',
  'MAX',
  'AVG',
  'SUM',
  'COUNT',
  'COUNT_UNIQUE_VALUES',
  'COUNT_EMPTY',
  'COUNT_NOT_EMPTY',
  'COUNT_TRUE',
  'COUNT_FALSE',
  'PERCENTAGE_EMPTY',
  'PERCENTAGE_NOT_EMPTY',
]);

const CalendarLayout = z.enum(['DAY', 'WEEK', 'MONTH']);

const ViewFilterOperand = z.enum([
  'IS',
  'IS_NOT',
  'IS_NOT_NULL',
  'CONTAINS',
  'DOES_NOT_CONTAIN',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
  'LESS_THAN_OR_EQUAL',
  'GREATER_THAN_OR_EQUAL',
  'IS_BEFORE',
  'IS_AFTER',
  'IS_RELATIVE',
  'IS_IN_PAST',
  'IS_IN_FUTURE',
  'IS_TODAY',
  'VECTOR_SEARCH',
]);

const ViewSortDirection = z.enum(['ASC', 'DESC']);

const AggregateOperation = z.enum([
  'COUNT',
  'COUNT_UNIQUE_VALUES',
  'COUNT_EMPTY',
  'COUNT_NOT_EMPTY',
  'COUNT_TRUE',
  'COUNT_FALSE',
  'PERCENTAGE_EMPTY',
  'PERCENTAGE_NOT_EMPTY',
  'MIN',
  'MAX',
  'AVG',
  'SUM',
]);

// --- Input schemas -----------------------------------------------------------

export const metadataCreateViewInputSchema = z.object({
  name: z.string().min(1).describe('View name (display).'),
  objectNameSingular: z
    .string()
    .min(1)
    .describe(
      'Singular humanised object name, e.g. "company". The factory resolves it to objectMetadataId internally.',
    ),
  visibility: ViewVisibility.describe(
    'WORKSPACE = visible to all members; UNLISTED = per-user (private). REQUIRED — Twenty defaults to WORKSPACE; the proxy forces an explicit choice.',
  ),
  type: ViewType.optional().describe('Defaults to TABLE.'),
  icon: z.string().optional().describe('Defaults to IconList.'),
  mainGroupByFieldName: z
    .string()
    .optional()
    .describe(
      'SELECT field name for kanban grouping. Required if type=KANBAN.',
    ),
  kanbanAggregateOperation: KanbanAggregateOperation.optional(),
  kanbanAggregateOperationFieldName: z.string().optional(),
  calendarLayout: CalendarLayout.optional().describe(
    'Required if type=CALENDAR.',
  ),
  calendarFieldName: z
    .string()
    .optional()
    .describe(
      'DATE/DATE_TIME field name for calendar views. Required if type=CALENDAR.',
    ),
  fieldNames: z
    .array(z.string())
    .optional()
    .describe('Field names to display in the view. Resolved internally.'),
});

export const metadataUpdateViewInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  icon: z.string().optional(),
});

export const metadataCreateViewFieldInputSchema = z.object({
  viewId: z.string().uuid(),
  fieldMetadataId: z
    .string()
    .uuid()
    .describe('Field id (UUID), not field name.'),
  isVisible: z.boolean().optional().describe('Defaults true.'),
  size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Column width in pixels. Defaults 150.'),
  position: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('0-based column position. Defaults 0.'),
  aggregateOperation: AggregateOperation.optional(),
});

export const metadataUpdateViewFieldInputSchema = z.object({
  id: z.string().uuid(),
  isVisible: z.boolean().optional(),
  size: z.number().int().positive().optional(),
  position: z.number().int().min(0).optional(),
  aggregateOperation: AggregateOperation.optional(),
});

export const metadataCreateManyViewFieldsInputSchema = z.object({
  viewFields: z
    .array(metadataCreateViewFieldInputSchema)
    .min(1)
    .max(50)
    .describe('Array of view fields to create (1-50 items).'),
});

export const metadataCreateViewFilterInputSchema = z.object({
  viewId: z.string().uuid(),
  fieldMetadataId: z.string().uuid(),
  operand: ViewFilterOperand,
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.record(z.string(), z.unknown()),
    ])
    .describe(
      'Filter value. Type depends on operand + field type. CONTAINS/DOES_NOT_CONTAIN on TEXT: string. IS/IS_NOT on SELECT: array of option values e.g. ["TIER_A"] — NOT a plain string. IS/IS_NOT on MULTI_SELECT: array of option values. IS_EMPTY/IS_NOT_EMPTY: empty string "". Etc.',
    ),
  subFieldName: z
    .string()
    .optional()
    .describe(
      'For composite fields: e.g. "amountMicros" for CURRENCY, "addressCity" for ADDRESS.',
    ),
});

export const metadataUpdateViewFilterInputSchema = z.object({
  id: z.string().uuid(),
  operand: ViewFilterOperand.optional(),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.record(z.string(), z.unknown()),
    ])
    .optional()
    .describe(
      'Filter value. Type depends on operand + field type. CONTAINS/DOES_NOT_CONTAIN on TEXT: string. IS/IS_NOT on SELECT: array of option values e.g. ["TIER_A"] — NOT a plain string. IS/IS_NOT on MULTI_SELECT: array of option values. IS_EMPTY/IS_NOT_EMPTY: empty string "". Etc.',
    ),
  subFieldName: z.string().optional(),
  fieldMetadataId: z.string().uuid().optional(),
});

export const metadataCreateViewSortInputSchema = z.object({
  viewId: z.string().uuid(),
  fieldMetadataId: z.string().uuid(),
  direction: ViewSortDirection.optional().describe('Defaults to ASC.'),
});

// --- Shared strip helper -----------------------------------------------------
//
// Strip wrapper-only `fieldMetadataId` before forwarding to Twenty's inner
// update_view_filter. fieldMetadataId is needed by the wrapper to look up the
// field type (for operand validation) but is NOT in Twenty's update_view_filter
// input schema. Twenty currently passthrough-accepts the extra prop, but would
// reject under .strict() Zod hardening — same #9 bug class.
export const stripFieldMetadataIdFromUpdateArgs = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const { fieldMetadataId: _, ...rest } = args;
  return rest;
};

// --- Coercion helpers --------------------------------------------------------

// Coerce SELECT IS/IS_NOT value from a plain string to a single-element array.
// Twenty's frontend expects an array for SELECT IS/IS_NOT filters; passing a
// string produces a UI crash (see issue #10).
const coerceSelectIsValue = (
  value: unknown,
  fieldType: string,
  operand: string,
): unknown => {
  if (
    fieldType === 'SELECT' &&
    (operand === 'IS' || operand === 'IS_NOT') &&
    typeof value === 'string'
  ) {
    return [value];
  }
  return value;
};

// --- Handlers ----------------------------------------------------------------

const wrapInExecute = (
  client: TwentyMcpClient,
  innerName: string,
  args: Record<string, unknown>,
): Promise<ToolsCallResult> =>
  client.toolsCall('execute_tool', { toolName: innerName, arguments: args });

const makeError = (text: string): ToolsCallResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

export const buildViewHandlers = (client: TwentyMcpClient) => ({
  metadataCreateView: (args: z.infer<typeof metadataCreateViewInputSchema>) =>
    wrapInExecute(client, 'create_view', args),

  metadataUpdateView: (args: z.infer<typeof metadataUpdateViewInputSchema>) =>
    wrapInExecute(client, 'update_view', args),

  metadataCreateViewField: (
    args: z.infer<typeof metadataCreateViewFieldInputSchema>,
  ) => wrapInExecute(client, 'create_view_field', args),

  metadataUpdateViewField: (
    args: z.infer<typeof metadataUpdateViewFieldInputSchema>,
  ) => wrapInExecute(client, 'update_view_field', args),

  metadataCreateManyViewFields: (
    args: z.infer<typeof metadataCreateManyViewFieldsInputSchema>,
  ) => wrapInExecute(client, 'create_many_view_fields', args),

  metadataCreateViewFilter: async (
    args: z.infer<typeof metadataCreateViewFilterInputSchema>,
  ): Promise<ToolsCallResult> => {
    // Validate operand is compatible with the field's type BEFORE forwarding to Twenty.
    const check = await assertOperandCompatible(
      client,
      args.fieldMetadataId,
      args.operand,
    );
    if (!check.valid) {
      return makeError(check.error);
    }

    const coercedValue = coerceSelectIsValue(
      args.value,
      check.fieldType ?? '',
      args.operand,
    );
    return wrapInExecute(client, 'create_view_filter', {
      ...args,
      value: coercedValue,
    });
  },

  metadataUpdateViewFilter: async (
    args: z.infer<typeof metadataUpdateViewFilterInputSchema>,
  ): Promise<ToolsCallResult> => {
    // If operand is being updated, validate it is compatible with the field's type.
    if (args.operand !== undefined) {
      if (!args.fieldMetadataId) {
        // FAIL CLOSED: cannot validate without fieldMetadataId. The only inner tool
        // that returns filter rows is get_view_filters({viewId}), and viewId is not
        // in the update schema — so there is no lookup path. Require the caller to
        // pass fieldMetadataId explicitly.
        return makeError(
          'metadata_update_view_filter requires fieldMetadataId when updating operand. ' +
            "Look up the existing filter's fieldMetadataId via metadata_query({kind: 'view_filters', args: {viewId: <viewId>}}) and pass it explicitly.",
        );
      }
      const check = await assertOperandCompatible(
        client,
        args.fieldMetadataId,
        args.operand,
      );
      if (!check.valid) {
        return makeError(check.error);
      }

      const coercedValue =
        args.value !== undefined
          ? coerceSelectIsValue(
              args.value,
              check.fieldType ?? '',
              args.operand!,
            )
          : args.value;
      return wrapInExecute(
        client,
        'update_view_filter',
        stripFieldMetadataIdFromUpdateArgs({ ...args, value: coercedValue }),
      );
    }

    return wrapInExecute(
      client,
      'update_view_filter',
      stripFieldMetadataIdFromUpdateArgs(args),
    );
  },

  metadataCreateViewSort: (
    args: z.infer<typeof metadataCreateViewSortInputSchema>,
  ) => wrapInExecute(client, 'create_view_sort', args),
});

// --- Dispatch entries (consumed by metadata.ts apply_plan) ------------------

export const viewsDispatchEntries: Record<string, DispatchEntry> = {
  CREATE_VIEW: { transport: 'inner_tool', innerToolName: 'create_view' },
  UPDATE_VIEW: { transport: 'inner_tool', innerToolName: 'update_view' },
  CREATE_VIEW_FIELD: {
    transport: 'inner_tool',
    innerToolName: 'create_view_field',
  },
  UPDATE_VIEW_FIELD: {
    transport: 'inner_tool',
    innerToolName: 'update_view_field',
  },
  CREATE_VIEW_FILTER: {
    transport: 'inner_tool',
    innerToolName: 'create_view_filter',
  },
  UPDATE_VIEW_FILTER: {
    transport: 'inner_tool',
    innerToolName: 'update_view_filter',
    argsTransform: stripFieldMetadataIdFromUpdateArgs,
  },
  CREATE_VIEW_SORT: {
    transport: 'inner_tool',
    innerToolName: 'create_view_sort',
  },
};

// --- Tool definitions --------------------------------------------------------

export const viewToolDefinitions = {
  metadata_create_view: {
    title: 'Create a saved view',
    description:
      'Create a TABLE/KANBAN/CALENDAR view on an object. Specify visibility explicitly (WORKSPACE = shared, UNLISTED = private). For KANBAN: pass `mainGroupByFieldName` (must be a SELECT field). For CALENDAR: pass `calendarFieldName` + `calendarLayout`.',
    inputSchema: metadataCreateViewInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_update_view: {
    title: "Update a view's name or icon",
    description:
      'Only name and icon are mutable post-create. Other view properties (type, visibility, kanban/calendar configs) are immutable; if you need to change them, create a new view and archive the old one (rename to `[archived] <name>`).',
    inputSchema: metadataUpdateViewInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  metadata_create_view_field: {
    title: 'Add a column to a view',
    description:
      'Add a field as a column in an existing view. fieldMetadataId is the UUID from `metadata_query({kind: "fields"})`, not the field name.',
    inputSchema: metadataCreateViewFieldInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_update_view_field: {
    title: "Update a view column's visibility, size, position, or aggregate",
    description:
      'Use `metadata_query({kind: "view_fields"})` to find the view-field id.',
    inputSchema: metadataUpdateViewFieldInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  metadata_create_many_view_fields: {
    title: 'Batch-add columns to a view',
    description: 'Add 1-50 columns in a single call.',
    inputSchema: metadataCreateManyViewFieldsInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_create_view_filter: {
    title: 'Add a filter to a view',
    description:
      'Add a filter row to an existing view. The wrapper validates operand-vs-field-type compatibility at runtime. Invalid combinations are rejected with an explicit error before reaching Twenty.\n\n' +
      OPERAND_MATRIX_DESCRIPTION +
      '\n\nFilter value rules (by operand): IS_EMPTY/IS_NOT_EMPTY: pass empty string "". CONTAINS/DOES_NOT_CONTAIN on TEXT: string. IS/IS_NOT on SELECT: array of option values e.g. ["TIER_A"] — NOT a plain string. CONTAINS on MULTI_SELECT: array of option values. IS_BEFORE/IS_AFTER/IS on DATE_TIME: ISO 8601 string. VECTOR_SEARCH on TS_VECTOR: search string.',
    inputSchema: metadataCreateViewFilterInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_update_view_filter: {
    title: 'Update a view filter',
    description:
      'Update an existing view filter row. Use `metadata_query({kind: "view_filters", args: {viewId: <viewId>}})` to find the filter id and existing field metadata.\n\n' +
      'The wrapper validates operand-vs-field-type compatibility at runtime. Invalid combinations are rejected with an explicit error before reaching Twenty. ' +
      'When updating `operand`, you MUST also supply `fieldMetadataId` — without it, the wrapper cannot validate the operand and will reject the call.\n\n' +
      OPERAND_MATRIX_DESCRIPTION,
    inputSchema: metadataUpdateViewFilterInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  metadata_create_view_sort: {
    title: 'Add a sort to a view',
    description:
      'Direction is ASC or DESC. Multiple sorts on the same view are stacked in the order created.',
    inputSchema: metadataCreateViewSortInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
} as const;
