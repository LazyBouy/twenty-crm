import { z } from 'zod';

import type { ToolsCallResult, TwentyMcpClient } from '../twenty-mcp-client';

export const discoveryInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Free-text filter on tool name or description. Empty = top-level catalog.'),
  focus: z
    .string()
    .optional()
    .describe(
      'Specific tool name. When set, returns the full input JSON Schema for that tool only. Use this before calling a tool you have not seen before.',
    ),
  category: z.string().optional().describe('Filter the catalog to a single category.'),
});

export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;

export const discoveryToolDefinition = {
  title: 'Twenty CRM tool discovery',
  description:
    'Single entry point for exploring what this Twenty CRM MCP server can do. ' +
    'Call with no arguments to see a brief catalog of available tools grouped by category. ' +
    'Pass {focus: "<tool_name>"} to fetch the full JSON Schema for a single tool. ' +
    'Pass {query: "..."} or {category: "..."} to narrow the catalog. ' +
    'This tool is read-only — it never invokes tools. Use the dedicated record tools (search_records / get_record / create_record / update_record / delete_record) or the agent\'s normal tool-calling flow to actually perform actions.',
  inputSchema: discoveryInputSchema.shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const;

const textResult = (text: string, isError = false): ToolsCallResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

const extractJsonFromText = (result: ToolsCallResult): unknown => {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      try {
        return JSON.parse(block.text);
      } catch {
        // Not all text blocks are JSON — fall through.
      }
    }
  }

  return undefined;
};

type CatalogEntry = { name: string; description?: string; category?: string };

const collectCatalog = (raw: unknown): CatalogEntry[] => {
  if (!raw) return [];

  // Twenty returns either a flat array or an object grouped by category.
  if (Array.isArray(raw)) {
    return raw.filter((e): e is CatalogEntry => typeof e === 'object' && e !== null && 'name' in e);
  }

  if (typeof raw === 'object') {
    const out: CatalogEntry[] = [];
    for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object' && 'name' in entry) {
            out.push({ category, ...(entry as Record<string, unknown>) } as CatalogEntry);
          }
        }
      }
    }

    return out;
  }

  return [];
};

const summarizeCatalog = (entries: CatalogEntry[]): string => {
  if (entries.length === 0) {
    return 'No tools matched.';
  }

  const byCategory = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const cat = entry.category ?? 'uncategorized';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(entry);
  }

  const lines: string[] = [`Found ${entries.length} tool(s):`, ''];
  for (const [cat, list] of byCategory) {
    lines.push(`## ${cat} (${list.length})`);
    for (const entry of list.slice(0, 8)) {
      const desc = entry.description ? ` — ${entry.description.split('\n')[0].slice(0, 120)}` : '';
      lines.push(`- \`${entry.name}\`${desc}`);
    }
    if (list.length > 8) lines.push(`  …and ${list.length - 8} more`);
    lines.push('');
  }

  lines.push(
    'Call discovery({focus: "<tool_name>"}) for a tool\'s full JSON Schema before invoking it.',
  );

  return lines.join('\n');
};

export const handleDiscovery = async (
  input: DiscoveryInput,
  client: TwentyMcpClient,
): Promise<ToolsCallResult> => {
  // focus mode: return the schema for a specific tool via Twenty's learn_tools.
  if (input.focus) {
    try {
      const result = await client.toolsCall('learn_tools', { tools: [input.focus] });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      return textResult(`learn_tools failed for "${input.focus}": ${message}`, true);
    }
  }

  // catalog mode: list available tools, optionally filtered.
  let catalog: ToolsCallResult;
  try {
    const args: Record<string, unknown> = {};
    if (input.category) args.category = input.category;
    catalog = await client.toolsCall('get_tool_catalog', args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return textResult(`get_tool_catalog failed: ${message}`, true);
  }

  const raw = extractJsonFromText(catalog);
  let entries = collectCatalog(raw);

  if (input.query) {
    const needle = input.query.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        (e.description ?? '').toLowerCase().includes(needle),
    );
  }

  if (entries.length === 0 && raw === undefined) {
    // Fall back to whatever Twenty returned verbatim — better than throwing away signal.
    return catalog;
  }

  return textResult(summarizeCatalog(entries));
};
