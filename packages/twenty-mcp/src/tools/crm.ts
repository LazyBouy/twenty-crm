import { z } from 'zod';

import { parseInnerOrGraphqlArray } from '../utils/parse-metadata-array';
import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';

/**
 * Canonical camelToSnakeCase algorithm — matches twenty-shared/src/utils/strings/camelToSnakeCase.ts
 * and packages/twenty-server/.../database-tool.provider.ts's tool-name registration.
 * Defined locally because twenty-shared has no compiled dist/ in this monorepo checkout;
 * import from 'twenty-shared/utils' once that package is built (follow-up).
 *
 * Algorithm: insert `_` before every uppercase letter, then lowercase the whole string.
 * For 'iOSDevice' → '_i_o_s_device' → trim leading _ → 'i_o_s_device'.
 * Twenty server registers 'i_o_s_device' not 'iosdevice'. This is the fix for #12.
 */
// TODO: replace with `import { camelToSnakeCase } from 'twenty-shared/utils'` once
// twenty-shared dist/ is compiled (see issue #12 Implementation notes).
const camelToSnakeCase = (str: string): string =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * Twenty exposes per-object CRUD tools using a predictable naming pattern derived
 * from the object name (snake_case). For "person":
 *   search → find_people
 *   get    → find_one_person
 *   create → create_person
 *   update → update_person
 *   delete → delete_person
 *
 * The agent can pass any casing/form of the object name — resolveObjectNames()
 * fetches the authoritative {nameSingular, namePlural} from server metadata via
 * metadata_query({kind: 'objects'}) and applies camelToSnakeCase directly.
 * This eliminates both the embedded-acronym bug (#12) and the mass-noun bug (#13).
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

type ObjectMetadataItem = {
  nameSingular: string;
  namePlural: string;
};

/**
 * Fetch the authoritative {nameSingular, namePlural} for the given agent-supplied
 * object name from the workspace's objectMetadata list.
 *
 * Matching is case-insensitive and accepts any of:
 *   - nameSingular / namePlural (as stored)
 *   - camelToSnakeCase(nameSingular) / camelToSnakeCase(namePlural) (snake forms)
 *   - lowercased equivalents of any of the above
 *
 * If two objects match under case-insensitive comparison, throws a disambiguation
 * error naming both matches (the user must then pass the exact nameSingular or
 * namePlural to disambiguate).
 *
 * If no match: throws a descriptive error listing available object names.
 *
 * NOTE: adds one network round-trip per CRUD call (~5–20 ms on local stack).
 * TODO: add in-process TTL cache — see follow-up (issue #12 Implementation notes).
 */
export const resolveObjectNames = async (
  client: TwentyMcpClient,
  input: string,
): Promise<{ nameSingular: string; namePlural: string }> => {
  let objectList: ObjectMetadataItem[];

  try {
    // Fetch object metadata via Twenty's inner tool. `metadata_query({kind:'objects'})`
    // in the proxy routes to execute_tool({toolName:'get_object_metadata'}) on Twenty's
    // /mcp endpoint — we call it directly here since crm.ts runs inside the proxy.
    const result = await client.toolsCall('execute_tool', {
      toolName: 'get_object_metadata',
      arguments: {},
    });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    objectList = parseInnerOrGraphqlArray<ObjectMetadataItem>(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch object metadata for resolving '${input}': ${message}. ` +
        `Verify the MCP server can reach Twenty.`,
    );
  }

  const needle = input.trim().toLowerCase();

  const candidates: ObjectMetadataItem[] = [];

  for (const obj of objectList) {
    const forms = [
      obj.nameSingular,
      obj.namePlural,
      camelToSnakeCase(obj.nameSingular),
      camelToSnakeCase(obj.namePlural),
    ].map((f) => f.toLowerCase());

    if (forms.includes(needle)) {
      candidates.push(obj);
    }
  }

  if (candidates.length === 1) {
    return { nameSingular: candidates[0].nameSingular, namePlural: candidates[0].namePlural };
  }

  if (candidates.length > 1) {
    const names = candidates.map((c) => `'${c.nameSingular}' / '${c.namePlural}'`).join(', ');
    throw new Error(
      `Object '${input}' is ambiguous — matches multiple objects: ${names}. ` +
        `Pass the exact nameSingular or namePlural to disambiguate.`,
    );
  }

  const available = objectList.map((o) => o.nameSingular).join(', ');
  throw new Error(
    `Object '${input}' not found in workspace. Available objects: [${available}]. ` +
      `Use discovery({focus: 'find_...'}) to inspect schemas.`,
  );
};

/**
 * Construct the inner Twenty tool name from already-resolved snake-cased
 * singular/plural forms and the CRUD operation.
 *
 * This is a pure synchronous function — callers must await resolveObjectNames
 * first to obtain the snake forms.
 */
export const buildToolName = (
  op: 'search' | 'get' | 'create' | 'update' | 'delete',
  snakeSingular: string,
  snakePlural: string,
): string => {
  switch (op) {
    case 'search':
      return `find_${snakePlural}`;
    case 'get':
      return `find_one_${snakeSingular}`;
    case 'create':
      return `create_${snakeSingular}`;
    case 'update':
      return `update_${snakeSingular}`;
    case 'delete':
      return `delete_${snakeSingular}`;
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
  searchRecords: async (args: z.infer<typeof searchInputSchema>) => {
    const { object, filter, ...rest } = args;
    const { nameSingular, namePlural } = await resolveObjectNames(client, object);
    const snakeSingular = camelToSnakeCase(nameSingular);
    const snakePlural = camelToSnakeCase(namePlural);

    return wrapInExecute(client, buildToolName('search', snakeSingular, snakePlural), {
      ...rest,
      ...(filter ?? {}),
    });
  },
  getRecord: async (args: z.infer<typeof getInputSchema>) => {
    const { nameSingular, namePlural } = await resolveObjectNames(client, args.object);
    const snakeSingular = camelToSnakeCase(nameSingular);
    const snakePlural = camelToSnakeCase(namePlural);
    return wrapInExecute(client, buildToolName('get', snakeSingular, snakePlural), {
      id: args.id,
    });
  },
  createRecord: async (args: z.infer<typeof createInputSchema>) => {
    const { nameSingular, namePlural } = await resolveObjectNames(client, args.object);
    const snakeSingular = camelToSnakeCase(nameSingular);
    const snakePlural = camelToSnakeCase(namePlural);
    return wrapInExecute(client, buildToolName('create', snakeSingular, snakePlural), args.data);
  },
  updateRecord: async (args: z.infer<typeof updateInputSchema>) => {
    const { nameSingular, namePlural } = await resolveObjectNames(client, args.object);
    const snakeSingular = camelToSnakeCase(nameSingular);
    const snakePlural = camelToSnakeCase(namePlural);
    return wrapInExecute(client, buildToolName('update', snakeSingular, snakePlural), {
      id: args.id,
      ...args.data,
    });
  },
  deleteRecord: async (args: z.infer<typeof deleteInputSchema>) => {
    const { nameSingular, namePlural } = await resolveObjectNames(client, args.object);
    const snakeSingular = camelToSnakeCase(nameSingular);
    const snakePlural = camelToSnakeCase(namePlural);
    return wrapInExecute(client, buildToolName('delete', snakeSingular, snakePlural), {
      id: args.id,
    });
  },
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

