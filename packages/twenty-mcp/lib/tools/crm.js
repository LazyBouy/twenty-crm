"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.crmToolDefinitions = exports.buildCrmHandlers = exports.deleteInputSchema = exports.updateInputSchema = exports.createInputSchema = exports.getInputSchema = exports.searchInputSchema = exports.innerToolName = void 0;
const pluralize_1 = __importDefault(require("pluralize"));
const zod_1 = require("zod");
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
const normalize = (object) => {
    const trimmed = object.trim().replace(/\s+/g, '_').toLowerCase();
    return {
        singular: pluralize_1.default.singular(trimmed),
        plural: pluralize_1.default.plural(trimmed),
    };
};
const innerToolName = (op, object) => {
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
exports.innerToolName = innerToolName;
const objectArg = zod_1.z
    .string()
    .min(1)
    .describe('CRM object name. Either singular ("person", "company") or plural ("people", "companies") — both forms route correctly. Includes custom objects.');
exports.searchInputSchema = zod_1.z.object({
    object: objectArg,
    filter: zod_1.z
        .record(zod_1.z.string(), zod_1.z.unknown())
        .optional()
        .describe('Field-level filters. Each key is a field name; the value is an operator object — e.g. {city: {eq: "Berlin"}}, {employees: {gt: 100}}, {name: {like: "%acme%"}}. The wrapper SPREADS these to the top level of the call. Combine with `or` / `and` / `not` for boolean composition.'),
    or: zod_1.z
        .array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()))
        .optional()
        .describe('OR composition — match if ANY filter in the array matches.'),
    and: zod_1.z
        .array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()))
        .optional()
        .describe('AND composition — match if ALL filters in the array match.'),
    not: zod_1.z
        .record(zod_1.z.string(), zod_1.z.unknown())
        .optional()
        .describe('NOT — match if the filter does NOT match.'),
    orderBy: zod_1.z
        .array(zod_1.z.record(zod_1.z.string(), zod_1.z.string()))
        .optional()
        .describe('Sort: array of single-key objects, e.g. [{employees: "DescNullsLast"}, {name: "AscNullsFirst"}]. Required for "top N" / "largest" / "smallest" queries.'),
    limit: zod_1.z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Max records to return (Twenty default 10, max 100).'),
    offset: zod_1.z.number().int().nonnegative().optional().describe('Records to skip.'),
});
exports.getInputSchema = zod_1.z.object({
    object: objectArg,
    id: zod_1.z.string().min(1).describe('Record id (uuid).'),
});
exports.createInputSchema = zod_1.z.object({
    object: objectArg,
    data: zod_1.z
        .record(zod_1.z.string(), zod_1.z.unknown())
        .describe('Field values for the new record. Top-level keys must match Twenty\'s field names for the object — call discovery({focus: "create_<singular>"}) to see the exact schema. The wrapper spreads `data` into the inner call, so do NOT pass a nested `data` key.'),
});
exports.updateInputSchema = zod_1.z.object({
    object: objectArg,
    id: zod_1.z.string().min(1),
    data: zod_1.z
        .record(zod_1.z.string(), zod_1.z.unknown())
        .describe('Fields to update. Top-level keys must match Twenty\'s field names — see discovery({focus: "update_<singular>"}). The wrapper spreads `data` alongside `id` into the inner call.'),
});
exports.deleteInputSchema = zod_1.z.object({
    object: objectArg,
    id: zod_1.z.string().min(1),
});
const wrapInExecute = async (client, innerName, args) => client.toolsCall('execute_tool', { toolName: innerName, arguments: args });
const buildCrmHandlers = (client) => ({
    searchRecords: (args) => {
        const { object, filter, ...rest } = args;
        return wrapInExecute(client, (0, exports.innerToolName)('search', object), {
            ...rest,
            ...(filter ?? {}),
        });
    },
    getRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('get', args.object), { id: args.id }),
    createRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('create', args.object), args.data),
    updateRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('update', args.object), {
        id: args.id,
        ...args.data,
    }),
    deleteRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('delete', args.object), { id: args.id }),
});
exports.buildCrmHandlers = buildCrmHandlers;
exports.crmToolDefinitions = {
    search_records: {
        title: 'Search CRM records',
        description: 'Search records of a given object (e.g. people, companies, opportunities, or any custom object). Routes to Twenty\'s `find_<plural>` tool, which expects field filters at the top level — the wrapper SPREADS `filter` for you. For exact field operators or composition, call discovery({focus: "find_<plural>"}).',
        inputSchema: exports.searchInputSchema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    },
    get_record: {
        title: 'Get a CRM record by id',
        description: 'Fetch a single record by its uuid. Routes to Twenty\'s `find_one_<singular>` tool.',
        inputSchema: exports.getInputSchema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    },
    create_record: {
        title: 'Create a CRM record',
        description: 'Create a new record. Pass field values as flat keys inside `data` — the wrapper SPREADS them to satisfy Twenty\'s `create_<singular>` schema (which is `additionalProperties: false`). Call discovery({focus: "create_<singular>"}) for the exact field list. Returns the created record.',
        inputSchema: exports.createInputSchema.shape,
        annotations: { destructiveHint: false, idempotentHint: false },
    },
    update_record: {
        title: 'Update a CRM record',
        description: 'Patch fields on an existing record. The wrapper sends `{id, ...data}` to Twenty\'s `update_<singular>` tool. Pass only the fields you want to change in `data`. Call discovery({focus: "update_<singular>"}) for the exact field list.',
        inputSchema: exports.updateInputSchema.shape,
        annotations: { destructiveHint: false, idempotentHint: true },
    },
    delete_record: {
        title: 'Delete a CRM record',
        description: 'Soft-delete a record by id (Twenty uses soft delete by default). Routes to Twenty\'s `delete_<singular>` tool.',
        inputSchema: exports.deleteInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
};
//# sourceMappingURL=crm.js.map