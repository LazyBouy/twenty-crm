"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDiscovery = exports.discoveryToolDefinition = exports.discoveryInputSchema = void 0;
const zod_1 = require("zod");
exports.discoveryInputSchema = zod_1.z.object({
    query: zod_1.z
        .string()
        .optional()
        .describe('Free-text filter on tool name or description. Empty = top-level catalog.'),
    focus: zod_1.z
        .string()
        .optional()
        .describe('Specific tool name. When set, returns the full input JSON Schema for that tool only. Use this before calling a tool you have not seen before.'),
    category: zod_1.z.string().optional().describe('Filter the catalog to a single category.'),
});
exports.discoveryToolDefinition = {
    title: 'Twenty CRM tool discovery',
    description: 'Single entry point for exploring what this Twenty CRM MCP server can do. ' +
        'Call with no arguments to see a brief catalog of available tools grouped by category. ' +
        'Pass {focus: "<tool_name>"} to fetch the full JSON Schema for a single tool. ' +
        'Pass {query: "..."} or {category: "..."} to narrow the catalog. ' +
        'This tool is read-only — it never invokes tools. Use the dedicated record tools (search_records / get_record / create_record / update_record / delete_record) or the agent\'s normal tool-calling flow to actually perform actions.',
    inputSchema: exports.discoveryInputSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
};
const textResult = (text, isError = false) => ({
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
});
const extractJsonFromText = (result) => {
    if (result.structuredContent !== undefined) {
        return result.structuredContent;
    }
    for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
            try {
                return JSON.parse(block.text);
            }
            catch {
                // Not all text blocks are JSON — fall through.
            }
        }
    }
    return undefined;
};
const collectCatalog = (raw) => {
    if (!raw)
        return [];
    // Twenty returns either a flat array or an object grouped by category.
    if (Array.isArray(raw)) {
        return raw.filter((e) => typeof e === 'object' && e !== null && 'name' in e);
    }
    if (typeof raw === 'object') {
        const out = [];
        for (const [category, value] of Object.entries(raw)) {
            if (Array.isArray(value)) {
                for (const entry of value) {
                    if (entry && typeof entry === 'object' && 'name' in entry) {
                        out.push({ category, ...entry });
                    }
                }
            }
        }
        return out;
    }
    return [];
};
const summarizeCatalog = (entries) => {
    if (entries.length === 0) {
        return 'No tools matched.';
    }
    const byCategory = new Map();
    for (const entry of entries) {
        const cat = entry.category ?? 'uncategorized';
        if (!byCategory.has(cat))
            byCategory.set(cat, []);
        byCategory.get(cat).push(entry);
    }
    const lines = [`Found ${entries.length} tool(s):`, ''];
    for (const [cat, list] of byCategory) {
        lines.push(`## ${cat} (${list.length})`);
        for (const entry of list.slice(0, 8)) {
            const desc = entry.description ? ` — ${entry.description.split('\n')[0].slice(0, 120)}` : '';
            lines.push(`- \`${entry.name}\`${desc}`);
        }
        if (list.length > 8)
            lines.push(`  …and ${list.length - 8} more`);
        lines.push('');
    }
    lines.push('Call discovery({focus: "<tool_name>"}) for a tool\'s full JSON Schema before invoking it.');
    return lines.join('\n');
};
const handleDiscovery = async (input, client) => {
    // focus mode: return the schema for a specific tool via Twenty's learn_tools.
    if (input.focus) {
        try {
            const result = await client.toolsCall('learn_tools', { tools: [input.focus] });
            return result;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return textResult(`learn_tools failed for "${input.focus}": ${message}`, true);
        }
    }
    // catalog mode: list available tools, optionally filtered.
    let catalog;
    try {
        const args = {};
        if (input.category)
            args.category = input.category;
        catalog = await client.toolsCall('get_tool_catalog', args);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(`get_tool_catalog failed: ${message}`, true);
    }
    const raw = extractJsonFromText(catalog);
    let entries = collectCatalog(raw);
    if (input.query) {
        const needle = input.query.toLowerCase();
        entries = entries.filter((e) => e.name.toLowerCase().includes(needle) ||
            (e.description ?? '').toLowerCase().includes(needle));
    }
    if (entries.length === 0 && raw === undefined) {
        // Fall back to whatever Twenty returned verbatim — better than throwing away signal.
        return catalog;
    }
    return textResult(summarizeCatalog(entries));
};
exports.handleDiscovery = handleDiscovery;
//# sourceMappingURL=discovery.js.map