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
    .describe('Singular humanised object name, e.g. "company". The factory resolves it to objectMetadataId internally.'),
  visibility: ViewVisibility.describe(
    'WORKSPACE = visible to all members; UNLISTED = per-user (private). REQUIRED — Twenty defaults to WORKSPACE; the proxy forces an explicit choice.',
  ),
  type: ViewType.optional().describe('Defaults to TABLE.'),
  icon: z.string().optional().describe('Defaults to IconList.'),
  mainGroupByFieldName: z
    .string()
    .optional()
    .describe('SELECT field name for kanban grouping. Required if type=KANBAN.'),
  kanbanAggregateOperation: KanbanAggregateOperation.optional(),
  kanbanAggregateOperationFieldName: z.string().optional(),
  calendarLayout: CalendarLayout.optional().describe('Required if type=CALENDAR.'),
  calendarFieldName: z
    .string()
    .optional()
    .describe('DATE/DATE_TIME field name for calendar views. Required if type=CALENDAR.'),
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
  fieldMetadataId: z.string().uuid().describe('Field id (UUID), not field name.'),
  isVisible: z.boolean().optional().describe('Defaults true.'),
  size: z.number().int().positive().optional().describe('Column width in pixels. Defaults 150.'),
  position: z.number().int().min(0).optional().describe('0-based column position. Defaults 0.'),
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
      'Filter value. Type depends on operand + field type. CONTAINS/DOES_NOT_CONTAIN on TEXT: string. IS/IS_NOT on SELECT: option value (UPPER_SNAKE_CASE). IS_EMPTY/IS_NOT_EMPTY: empty string "". CONTAINS on MULTI_SELECT: string array. Etc.',
    ),
  subFieldName: z
    .string()
    .optional()
    .describe('For composite fields: e.g. "amountMicros" for CURRENCY, "addressCity" for ADDRESS.'),
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
    .optional(),
  subFieldName: z.string().optional(),
  fieldMetadataId: z.string().uuid().optional(),
});

export const metadataCreateViewSortInputSchema = z.object({
  viewId: z.string().uuid(),
  fieldMetadataId: z.string().uuid(),
  direction: ViewSortDirection.optional().describe('Defaults to ASC.'),
});

// --- Handlers ----------------------------------------------------------------

const wrapInExecute = (
  client: TwentyMcpClient,
  innerName: string,
  args: Record<string, unknown>,
): Promise<ToolsCallResult> =>
  client.toolsCall('execute_tool', { toolName: innerName, arguments: args });

export const buildViewHandlers = (client: TwentyMcpClient) => ({
  metadataCreateView: (args: z.infer<typeof metadataCreateViewInputSchema>) =>
    wrapInExecute(client, 'create_view', args),

  metadataUpdateView: (args: z.infer<typeof metadataUpdateViewInputSchema>) =>
    wrapInExecute(client, 'update_view', args),

  metadataCreateViewField: (args: z.infer<typeof metadataCreateViewFieldInputSchema>) =>
    wrapInExecute(client, 'create_view_field', args),

  metadataUpdateViewField: (args: z.infer<typeof metadataUpdateViewFieldInputSchema>) =>
    wrapInExecute(client, 'update_view_field', args),

  metadataCreateManyViewFields: (
    args: z.infer<typeof metadataCreateManyViewFieldsInputSchema>,
  ) => wrapInExecute(client, 'create_many_view_fields', args),

  metadataCreateViewFilter: (args: z.infer<typeof metadataCreateViewFilterInputSchema>) =>
    wrapInExecute(client, 'create_view_filter', args),

  metadataUpdateViewFilter: (args: z.infer<typeof metadataUpdateViewFilterInputSchema>) =>
    wrapInExecute(client, 'update_view_filter', args),

  metadataCreateViewSort: (args: z.infer<typeof metadataCreateViewSortInputSchema>) =>
    wrapInExecute(client, 'create_view_sort', args),
});

// --- Dispatch entries (consumed by metadata.ts apply_plan) ------------------

export const viewsDispatchEntries: Record<string, DispatchEntry> = {
  CREATE_VIEW: { transport: 'inner_tool', innerToolName: 'create_view' },
  UPDATE_VIEW: { transport: 'inner_tool', innerToolName: 'update_view' },
  CREATE_VIEW_FIELD: { transport: 'inner_tool', innerToolName: 'create_view_field' },
  UPDATE_VIEW_FIELD: { transport: 'inner_tool', innerToolName: 'update_view_field' },
  CREATE_VIEW_FILTER: { transport: 'inner_tool', innerToolName: 'create_view_filter' },
  UPDATE_VIEW_FILTER: { transport: 'inner_tool', innerToolName: 'update_view_filter' },
  CREATE_VIEW_SORT: { transport: 'inner_tool', innerToolName: 'create_view_sort' },
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
    title: 'Update a view\'s name or icon',
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
    title: 'Update a view column\'s visibility, size, position, or aggregate',
    description: 'Use `metadata_query({kind: "view_fields"})` to find the view-field id.',
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
      'Filter values follow Twenty\'s typing rules per operand + field type. Refer to the operand enum: IS / IS_NOT / IS_NOT_NULL / CONTAINS / DOES_NOT_CONTAIN / IS_EMPTY / IS_NOT_EMPTY / LESS_THAN_OR_EQUAL / GREATER_THAN_OR_EQUAL / IS_BEFORE / IS_AFTER / IS_RELATIVE / IS_IN_PAST / IS_IN_FUTURE / IS_TODAY / VECTOR_SEARCH.',
    inputSchema: metadataCreateViewFilterInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  metadata_update_view_filter: {
    title: 'Update a view filter',
    description: 'Use `metadata_query({kind: "view_filters"})` to find the filter id.',
    inputSchema: metadataUpdateViewFilterInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  metadata_create_view_sort: {
    title: 'Add a sort to a view',
    description: 'Direction is ASC or DESC. Multiple sorts on the same view are stacked in the order created.',
    inputSchema: metadataCreateViewSortInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
  },
} as const;
