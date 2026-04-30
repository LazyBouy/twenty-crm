"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.crmToolDefinitions = exports.buildCrmHandlers = exports.deleteInputSchema = exports.updateInputSchema = exports.createInputSchema = exports.getInputSchema = exports.searchInputSchema = exports.resolveInnerToolNames = exports.DEFAULT_INNER_TOOL_NAMES = void 0;
const zod_1 = require("zod");
/**
 * Inner tool names exposed by Twenty's COMMON_PRELOAD_TOOLS registry.
 * These are best-effort defaults — they can be overridden at runtime via the
 * TWENTY_MCP_INNER_TOOLS env var (JSON object) if Twenty renames them.
 */
exports.DEFAULT_INNER_TOOL_NAMES = {
    search: 'search_records',
    get: 'find_one_record',
    create: 'create_one_record',
    update: 'update_one_record',
    delete: 'delete_one_record',
};
const resolveInnerToolNames = (env = process.env) => {
    const raw = env.TWENTY_MCP_INNER_TOOLS;
    if (!raw)
        return exports.DEFAULT_INNER_TOOL_NAMES;
    try {
        const parsed = JSON.parse(raw);
        return { ...exports.DEFAULT_INNER_TOOL_NAMES, ...parsed };
    }
    catch {
        return exports.DEFAULT_INNER_TOOL_NAMES;
    }
};
exports.resolveInnerToolNames = resolveInnerToolNames;
const objectArg = zod_1.z
    .string()
    .min(1)
    .describe('Plural object name as known to Twenty (e.g. "people", "companies", "opportunities", "notes", "tasks", or any custom object).');
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
const wrapInExecute = async (client, innerName, args) => {
    return client.toolsCall('execute_tool', { name: innerName, arguments: args });
};
const buildCrmHandlers = (client, inner = exports.DEFAULT_INNER_TOOL_NAMES) => ({
    searchRecords: (args) => wrapInExecute(client, inner.search, args),
    getRecord: (args) => wrapInExecute(client, inner.get, args),
    createRecord: (args) => wrapInExecute(client, inner.create, args),
    updateRecord: (args) => wrapInExecute(client, inner.update, args),
    deleteRecord: (args) => wrapInExecute(client, inner.delete, args),
});
exports.buildCrmHandlers = buildCrmHandlers;
exports.crmToolDefinitions = {
    search_records: {
        title: 'Search CRM records',
        description: 'Search records of a given object (e.g. people, companies, opportunities). Use discovery({focus: "search_records"}) for the full schema if needed.',
        inputSchema: exports.searchInputSchema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    },
    get_record: {
        title: 'Get a CRM record by id',
        description: 'Fetch a single record by its uuid.',
        inputSchema: exports.getInputSchema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    },
    create_record: {
        title: 'Create a CRM record',
        description: 'Create a new record on a given object. Returns the created record.',
        inputSchema: exports.createInputSchema.shape,
        annotations: { destructiveHint: false, idempotentHint: false },
    },
    update_record: {
        title: 'Update a CRM record',
        description: 'Patch fields on an existing record. Returns the updated record.',
        inputSchema: exports.updateInputSchema.shape,
        annotations: { destructiveHint: false, idempotentHint: true },
    },
    delete_record: {
        title: 'Delete a CRM record',
        description: 'Soft-delete a record by id (Twenty uses soft delete by default).',
        inputSchema: exports.deleteInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
};
//# sourceMappingURL=crm.js.map