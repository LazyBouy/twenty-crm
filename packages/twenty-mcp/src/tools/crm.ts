import { z } from 'zod';

import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';

/**
 * Inner tool names exposed by Twenty's COMMON_PRELOAD_TOOLS registry.
 * These are best-effort defaults — they can be overridden at runtime via the
 * TWENTY_MCP_INNER_TOOLS env var (JSON object) if Twenty renames them.
 */
export const DEFAULT_INNER_TOOL_NAMES = {
  search: 'search_records',
  get: 'find_one_record',
  create: 'create_one_record',
  update: 'update_one_record',
  delete: 'delete_one_record',
} as const;

export type InnerToolNames = typeof DEFAULT_INNER_TOOL_NAMES;

export const resolveInnerToolNames = (env: NodeJS.ProcessEnv = process.env): InnerToolNames => {
  const raw = env.TWENTY_MCP_INNER_TOOLS;
  if (!raw) return DEFAULT_INNER_TOOL_NAMES;
  try {
    const parsed = JSON.parse(raw) as Partial<InnerToolNames>;

    return { ...DEFAULT_INNER_TOOL_NAMES, ...parsed };
  } catch {
    return DEFAULT_INNER_TOOL_NAMES;
  }
};

const objectArg = z
  .string()
  .min(1)
  .describe(
    'Plural object name as known to Twenty (e.g. "people", "companies", "opportunities", "notes", "tasks", or any custom object).',
  );

export const searchInputSchema = z.object({
  object: objectArg,
  query: z.string().optional().describe('Free-text query to match against record fields.'),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Field-level filter, e.g. {city: {eq: "Berlin"}}.'),
  limit: z.number().int().positive().max(200).optional().describe('Max records to return.'),
  fields: z.array(z.string()).optional().describe('Subset of fields to return per record.'),
});

export const getInputSchema = z.object({
  object: objectArg,
  id: z.string().min(1).describe('Record id (uuid).'),
  fields: z.array(z.string()).optional(),
});

export const createInputSchema = z.object({
  object: objectArg,
  data: z.record(z.string(), z.unknown()).describe('Field values for the new record.'),
});

export const updateInputSchema = z.object({
  object: objectArg,
  id: z.string().min(1),
  data: z.record(z.string(), z.unknown()).describe('Fields to update.'),
});

export const deleteInputSchema = z.object({
  object: objectArg,
  id: z.string().min(1),
});

const wrapInExecute = async (
  client: TwentyMcpClient,
  innerName: string,
  args: Record<string, unknown>,
): Promise<ToolsCallResult> => {
  return client.toolsCall('execute_tool', { name: innerName, arguments: args });
};

export const buildCrmHandlers = (
  client: TwentyMcpClient,
  inner: InnerToolNames = DEFAULT_INNER_TOOL_NAMES,
) => ({
  searchRecords: (args: z.infer<typeof searchInputSchema>) =>
    wrapInExecute(client, inner.search, args),
  getRecord: (args: z.infer<typeof getInputSchema>) => wrapInExecute(client, inner.get, args),
  createRecord: (args: z.infer<typeof createInputSchema>) =>
    wrapInExecute(client, inner.create, args),
  updateRecord: (args: z.infer<typeof updateInputSchema>) =>
    wrapInExecute(client, inner.update, args),
  deleteRecord: (args: z.infer<typeof deleteInputSchema>) =>
    wrapInExecute(client, inner.delete, args),
});

export const crmToolDefinitions = {
  search_records: {
    title: 'Search CRM records',
    description:
      'Search records of a given object (e.g. people, companies, opportunities). Use discovery({focus: "search_records"}) for the full schema if needed.',
    inputSchema: searchInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  get_record: {
    title: 'Get a CRM record by id',
    description: 'Fetch a single record by its uuid.',
    inputSchema: getInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  create_record: {
    title: 'Create a CRM record',
    description: 'Create a new record on a given object. Returns the created record.',
    inputSchema: createInputSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  update_record: {
    title: 'Update a CRM record',
    description: 'Patch fields on an existing record. Returns the updated record.',
    inputSchema: updateInputSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  delete_record: {
    title: 'Delete a CRM record',
    description: 'Soft-delete a record by id (Twenty uses soft delete by default).',
    inputSchema: deleteInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
} as const;
