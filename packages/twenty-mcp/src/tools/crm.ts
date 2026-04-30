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
 */
const normalize = (object: string): { singular: string; plural: string } => {
  const trimmed = object.trim().replace(/\s+/g, '_').toLowerCase();

  return {
    singular: pluralize.singular(trimmed),
    plural: pluralize.plural(trimmed),
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
): Promise<ToolsCallResult> =>
  client.toolsCall('execute_tool', { toolName: innerName, arguments: args });

const stripObject = <T extends { object: string }>(args: T): Omit<T, 'object'> => {
  const { object: _ignored, ...rest } = args;

  return rest;
};

export const buildCrmHandlers = (client: TwentyMcpClient) => ({
  searchRecords: (args: z.infer<typeof searchInputSchema>) =>
    wrapInExecute(client, innerToolName('search', args.object), stripObject(args)),
  getRecord: (args: z.infer<typeof getInputSchema>) =>
    wrapInExecute(client, innerToolName('get', args.object), stripObject(args)),
  createRecord: (args: z.infer<typeof createInputSchema>) =>
    wrapInExecute(client, innerToolName('create', args.object), stripObject(args)),
  updateRecord: (args: z.infer<typeof updateInputSchema>) =>
    wrapInExecute(client, innerToolName('update', args.object), stripObject(args)),
  deleteRecord: (args: z.infer<typeof deleteInputSchema>) =>
    wrapInExecute(client, innerToolName('delete', args.object), stripObject(args)),
});

export const crmToolDefinitions = {
  search_records: {
    title: 'Search CRM records',
    description:
      'Search records of a given object (e.g. people, companies, opportunities, or any custom object). Routes to Twenty\'s `find_<plural>` tool. Use discovery({focus: "find_<plural>"}) for the inner tool\'s full schema if you need advanced filtering.',
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
      'Create a new record on a given object. Routes to Twenty\'s `create_<singular>` tool. Returns the created record.',
    inputSchema: createInputSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  update_record: {
    title: 'Update a CRM record',
    description:
      'Patch fields on an existing record. Routes to Twenty\'s `update_<singular>` tool. Returns the updated record.',
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
