"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.crmToolDefinitions = exports.buildCrmHandlers = exports.deleteInputSchema = exports.updateInputSchema = exports.createInputSchema = exports.getInputSchema = exports.searchInputSchema = exports.innerToolName = void 0;
const tslib_1 = require("tslib");
const pluralize_1 = tslib_1.__importDefault(require("pluralize"));
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
    query: zod_1.z.string().optional().describe('Free-text query to match against record fields.'),
    filter: zod_1.z
        .record(zod_1.z.string(), zod_1.z.unknown())
        .optional()
        .describe('Field-level filter, e.g. {city: {eq: "Berlin"}}.'),
    limit: zod_1.z.number().int().positive().max(200).optional().describe('Max records to return.'),
    fields: zod_1.z.array(zod_1.z.string()).optional().describe('Subset of fields to return per record.'),
});
exports.getInputSchema = zod_1.z.object({
    object: objectArg,
    id: zod_1.z.string().min(1).describe('Record id (uuid).'),
    fields: zod_1.z.array(zod_1.z.string()).optional(),
});
exports.createInputSchema = zod_1.z.object({
    object: objectArg,
    data: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).describe('Field values for the new record.'),
});
exports.updateInputSchema = zod_1.z.object({
    object: objectArg,
    id: zod_1.z.string().min(1),
    data: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).describe('Fields to update.'),
});
exports.deleteInputSchema = zod_1.z.object({
    object: objectArg,
    id: zod_1.z.string().min(1),
});
const wrapInExecute = async (client, innerName, args) => client.toolsCall('execute_tool', { toolName: innerName, arguments: args });
const stripObject = (args) => {
    const { object: _ignored, ...rest } = args;
    return rest;
};
const buildCrmHandlers = (client) => ({
    searchRecords: (args) => wrapInExecute(client, (0, exports.innerToolName)('search', args.object), stripObject(args)),
    getRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('get', args.object), stripObject(args)),
    createRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('create', args.object), stripObject(args)),
    updateRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('update', args.object), stripObject(args)),
    deleteRecord: (args) => wrapInExecute(client, (0, exports.innerToolName)('delete', args.object), stripObject(args)),
});
exports.buildCrmHandlers = buildCrmHandlers;
exports.crmToolDefinitions = {
    search_records: {
        title: 'Search CRM records',
        description: 'Search records of a given object (e.g. people, companies, opportunities, or any custom object). Routes to Twenty\'s `find_<plural>` tool. Use discovery({focus: "find_<plural>"}) for the inner tool\'s full schema if you need advanced filtering.',
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
        description: 'Create a new record on a given object. Routes to Twenty\'s `create_<singular>` tool. Returns the created record.',
        inputSchema: exports.createInputSchema.shape,
        annotations: { destructiveHint: false, idempotentHint: false },
    },
    update_record: {
        title: 'Update a CRM record',
        description: 'Patch fields on an existing record. Routes to Twenty\'s `update_<singular>` tool. Returns the updated record.',
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