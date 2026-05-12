import pluralize from 'pluralize';
import { z } from 'zod';

import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';

/**
 * Twenty exposes per-object CRUD tools using a predictable naming pattern derived
 * from the object name (snake_case). For "person":
 *   search → find_people
 *   get    → find_one_person
 *   create → create_person
 *   update → update_person
 *   delete → delete_person
 *
 * The agent can pass either the plural or singular form of `object` — we normalize
 * both via the `pluralize` package, so "people" and "person" both route correctly.
 *
 * SHAPE CONTRACT (verified against Twenty source — see audit in PLAN.md):
 *  - find_<plural>:  { limit?, offset?, orderBy?, …top-level field filters, or?, and?, not? }
 *  - find_one_<sg>:  { id }
 *  - create_<sg>:    { …field keys at TOP LEVEL } — `additionalProperties: false`
 *  - update_<sg>:    { id, …field keys at TOP LEVEL } — `additionalProperties: false`
 *  - delete_<sg>:    { id }
 *
 * The wrapper schemas keep `data` / `filter` as containers so agents have a
 * Zod-checkable shape, and the handlers spread them into the inner-tool call
 * to satisfy Twenty's flat schemas.
 */
const normalize = (object: string): { singular: string; plural: string } => {
  // Insert underscores at camelCase boundaries BEFORE lowercasing, so
  // multi-word custom objects (`schemaChangeAudits` → `schema_change_audits`)
  // match Twenty server's tool names (registered via camelToSnakeCase in
  // packages/twenty-server/.../database-tool.provider.ts). Without this,
  // toLowerCase strips word boundaries and pluralize is a no-op, producing
  // `find_schemachangeaudits` instead of `find_schema_change_audits`.
  // See issue #11 for the full failure mode.
  const snakeified = object
    .trim()
    .replace(/\s+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return {
    singular: pluralize.singular(snakeified),
    plural: pluralize.plural(snakeified),
  };
};

export const innerToolName = (
  op: 'search' | 'get' | 'create' | 'update' | 'delete',
  object: string,
): string => {
  const { singular, plural } = normalize(object);
  switch (op) {
    case 'search':
      return `find_${plural}`;
    case 'get':
      return `find_one_${singular}`;
    case 'create':
      return `create_${singular}`;
    case 'update':
      return `update_${singular}`;
    case 'delete':
      return `delete_${singular}`;
  }
};

const objectArg = z
  .string()
  .min(1)
  .describe(
    'CRM object name. Either singular ("person", "company") or plural ("people", "companies") — both forms route correctly. Includes custom objects.',
  );

export const searchInputSchema = z.object({
  object: objectArg,
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Field-level filters. Each key is a field name; the value is an operator object — e.g. {city: {eq: "Berlin"}}, {employees: {gt: 100}}, {name: {like: "%acme%"}}. The wrapper SPREADS these to the top level of the call. Combine with `or` / `and` / `not` for boolean composition.',
    ),
  or: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('OR composition — match if ANY filter in the array matches.'),
  and: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('AND composition — match if ALL filters in the array match.'),
  not: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('NOT — match if the filter does NOT match.'),
  orderBy: z
    .array(z.record(z.string(), z.string()))
    .optional()
    .describe(
      'Sort: array of single-key objects, e.g. [{employees: "DescNullsLast"}, {name: "AscNullsFirst"}]. Required for "top N" / "largest" / "smallest" queries.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Max records to return (Twenty default 10, max 100).'),
  offset: z.number().int().nonnegative().optional().describe('Records to skip.'),
});

export const getInputSchema = z.object({
  object: objectArg,
  id: z.string().min(1).describe('Record id (uuid).'),
});

export const createInputSchema = z.object({
  object: objectArg,
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'Field values for the new record. Top-level keys must match Twenty\'s field names for the object — call discovery({focus: "create_<singular>"}) to see the exact schema. The wrapper spreads `data` into the inner call, so do NOT pass a nested `data` key.',
    ),
});

export const updateInputSchema = z.object({
  object: objectArg,
  id: z.string().min(1),
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'Fields to update. Top-level keys must match Twenty\'s field names — see discovery({focus: "update_<singular>"}). The wrapper spreads `data` alongside `id` into the inner call.',
    ),
});

export const deleteInputSchema = z.object({
  object: objectArg,
  id: z.string().min(1),
});

const wrapInExecute = async (
  client: TwentyMcpClient,
  innerName: string,
  args: Record<string, unknown>,
): Promise<ToolsCallResult> =>
  client.toolsCall('execute_tool', { toolName: innerName, arguments: args });

export const buildCrmHandlers = (client: TwentyMcpClient) => ({
  searchRecords: (args: z.infer<typeof searchInputSchema>) => {
    const { object, filter, ...rest } = args;

    return wrapInExecute(client, innerToolName('search', object), {
      ...rest,
      ...(filter ?? {}),
    });
  },
  getRecord: (args: z.infer<typeof getInputSchema>) =>
    wrapInExecute(client, innerToolName('get', args.object), { id: args.id }),
  createRecord: (args: z.infer<typeof createInputSchema>) =>
    wrapInExecute(client, innerToolName('create', args.object), args.data),
  updateRecord: (args: z.infer<typeof updateInputSchema>) =>
    wrapInExecute(client, innerToolName('update', args.object), {
      id: args.id,
      ...args.data,
    }),
  deleteRecord: (args: z.infer<typeof deleteInputSchema>) =>
    wrapInExecute(client, innerToolName('delete', args.object), { id: args.id }),
});

export const crmToolDefinitions = {
  search_records: {
    title: 'Search CRM records',
    description:
      'Search records of a given object (e.g. people, companies, opportunities, or any custom object). Routes to Twenty\'s `find_<plural>` tool, which expects field filters at the top level — the wrapper SPREADS `filter` for you. For exact field operators or composition, call discovery({focus: "find_<plural>"}).',
    inputSchema: searchInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  get_record: {
    title: 'Get a CRM record by id',
    description: 'Fetch a single record by its uuid. Routes to Twenty\'s `find_one_<singular>` tool.',
    inputSchema: getInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  create_record: {
    title: 'Create a CRM record',
    description:
      'Create a new record. Pass field values as flat keys inside `data` — the wrapper SPREADS them to satisfy Twenty\'s `create_<singular>` schema (which is `additionalProperties: false`). Call discovery({focus: "create_<singular>"}) for the exact field list. Returns the created record.',
    inputSchema: createInputSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  update_record: {
    title: 'Update a CRM record',
    description:
      'Patch fields on an existing record. The wrapper sends `{id, ...data}` to Twenty\'s `update_<singular>` tool. Pass only the fields you want to change in `data`. Call discovery({focus: "update_<singular>"}) for the exact field list.',
    inputSchema: updateInputSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  delete_record: {
    title: 'Delete a CRM record',
    description:
      'Soft-delete a record by id (Twenty uses soft delete by default). Routes to Twenty\'s `delete_<singular>` tool.',
    inputSchema: deleteInputSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: true },
  },
} as const;
