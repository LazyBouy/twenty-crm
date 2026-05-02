#!/usr/bin/env -S npx tsx
/**
 * capture-inner-schemas.ts
 *
 * Connects to a live Twenty's /mcp endpoint, calls `learn_tools` for the
 * inner-tool names that this package's wrappers invoke, and writes the result
 * to src/__tests__/fixtures/inner-tool-schemas.json.
 *
 * Usage:
 *   TWENTY_BASE_URL=http://localhost:4440 \
 *   TWENTY_API_KEY=<workspace-key> \
 *   npx tsx scripts/capture-inner-schemas.ts [--object <singular>] [--out <path>]
 *
 * `--object` lets you capture per-object CRUD schemas (find_<plural>,
 * find_one_<singular>, create/update/delete_<singular>) for a specific
 * object. Defaults to "person".
 *
 * The capture preserves the existing fixture's `forbiddenTopLevel` lists
 * (curated invariants) and only updates `schema` fields with the live
 * `learn_tools` output. Diff the result and commit if it looks reasonable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pluralize from 'pluralize';

import { TwentyMcpClient } from '../src/twenty-mcp-client';

type Fixture = {
  $comment?: string;
  $source?: string;
  tools: Record<
    string,
    {
      $shape?: string;
      schema: unknown;
      forbiddenTopLevel: string[];
    }
  >;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '..', 'src', '__tests__', 'fixtures', 'inner-tool-schemas.json');
const CATALOG_PATH = join(HERE, '..', 'src', '__tests__', 'fixtures', 'tools-catalog.json');

// Inner tool names this proxy wraps (kept in sync with src/tools/*.ts).
const STATIC_INNER_TOOL_NAMES = [
  // metadata
  'create_object_metadata',
  'update_object_metadata',
  'create_field_metadata',
  'update_field_metadata',
  'create_many_field_metadata',
  'create_many_relation_fields',
  // views
  'create_view',
  'update_view',
  'create_view_field',
  'update_view_field',
  'create_many_view_fields',
  'create_view_filter',
  'update_view_filter',
  'create_view_sort',
  // workflows
  'create_complete_workflow',
  'activate_workflow_version',
  'deactivate_workflow_version',
  'create_workflow_version_step',
  'update_workflow_version_step',
  'create_workflow_version_edge',
  'create_draft_from_workflow_version',
];

const parseArgs = (argv: string[]) => {
  const out: { object: string; outPath: string } = { object: 'person', outPath: FIXTURE_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--object' && argv[i + 1]) out.object = argv[++i]!;
    else if (argv[i] === '--out' && argv[i + 1]) out.outPath = argv[++i]!;
  }

  return out;
};

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`[capture] missing env var ${name}\n`);
    process.exit(1);
  }

  return v;
};

const extractSchemas = (
  result: { content: Array<{ type: string; text?: string }> },
): Record<string, unknown> => {
  const block = result.content.find((c) => c.type === 'text' && typeof c.text === 'string');
  if (!block?.text) return {};
  try {
    const parsed = JSON.parse(block.text) as Record<string, unknown>;
    // learn_tools wraps as either { tools: { name: { schema, ... } } } or flat.
    const candidate =
      typeof parsed === 'object' && parsed !== null && 'tools' in parsed
        ? (parsed as { tools: Record<string, unknown> }).tools
        : parsed;

    return candidate as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`[capture] failed to parse learn_tools result: ${String(err)}\n`);

    return {};
  }
};

const main = async () => {
  const baseUrl = requireEnv('TWENTY_BASE_URL');
  const apiKey = requireEnv('TWENTY_API_KEY');
  const args = parseArgs(process.argv.slice(2));

  const client = new TwentyMcpClient({ baseUrl, apiKey });

  // Per-object dynamic CRUD schemas — pick a representative object.
  const sg = pluralize.singular(args.object);
  const pl = pluralize.plural(args.object);
  const dynamicNames = [
    `find_${pl}`,
    `find_one_${sg}`,
    `create_${sg}`,
    `update_${sg}`,
    `delete_${sg}`,
  ];

  const allNames = [...dynamicNames, ...STATIC_INNER_TOOL_NAMES];

  process.stderr.write(`[capture] requesting learn_tools for ${allNames.length} tools…\n`);
  const result = await client.toolsCall('learn_tools', { toolNames: allNames });
  const schemas = extractSchemas(result);
  process.stderr.write(`[capture] received ${Object.keys(schemas).length} schemas\n`);

  // Merge into the existing fixture, preserving forbiddenTopLevel curation.
  const existing = JSON.parse(readFileSync(args.outPath, 'utf8')) as Fixture;
  const merged: Fixture = {
    ...existing,
    $source: `Captured from ${baseUrl} on ${new Date().toISOString()} (object=${args.object}). Hand-curated forbiddenTopLevel preserved.`,
    tools: { ...existing.tools },
  };

  // Map dynamic names back to <plural>/<singular> placeholders so the fixture
  // remains object-agnostic.
  const dynamicPlaceholders: Record<string, string> = {
    [`find_${pl}`]: 'find_<plural>',
    [`find_one_${sg}`]: 'find_one_<singular>',
    [`create_${sg}`]: 'create_<singular>',
    [`update_${sg}`]: 'update_<singular>',
    [`delete_${sg}`]: 'delete_<singular>',
  };

  for (const [name, entry] of Object.entries(schemas)) {
    const fixtureKey = dynamicPlaceholders[name] ?? name;
    const inner = (entry as { schema?: unknown; description?: string }).schema ?? entry;
    if (!merged.tools[fixtureKey]) {
      merged.tools[fixtureKey] = { schema: null, forbiddenTopLevel: [] };
    }
    merged.tools[fixtureKey] = {
      ...merged.tools[fixtureKey],
      schema: inner,
    };
  }

  writeFileSync(args.outPath, JSON.stringify(merged, null, 2) + '\n');
  process.stderr.write(`[capture] wrote ${args.outPath}\n`);

  // Also capture the full tools/list catalog so coverage.test.ts can verify
  // every literal toolName in the wrappers exists on the deployed Twenty.
  process.stderr.write(`[capture] requesting get_tool_catalog for full inventory…\n`);
  const catalogResult = await client.toolsCall('get_tool_catalog', {});
  const catalogBlock = catalogResult.content.find(
    (c) => c.type === 'text' && typeof c.text === 'string',
  );
  if (!catalogBlock?.text) {
    process.stderr.write(`[capture] WARNING: no catalog text block returned\n`);
  } else {
    const parsed = JSON.parse(catalogBlock.text) as { catalog?: Record<string, unknown> };
    const catalog = parsed.catalog ?? parsed;
    const allNames: string[] = [];
    if (catalog && typeof catalog === 'object') {
      for (const items of Object.values(catalog as Record<string, unknown>)) {
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item && typeof item === 'object' && 'name' in item) {
              allNames.push(String((item as { name: string }).name));
            }
          }
        }
      }
    }
    const catalogOut = {
      $source: `Captured from ${baseUrl} on ${new Date().toISOString()}`,
      $count: allNames.length,
      tools: allNames.sort(),
      catalogByCategory: catalog,
    };
    writeFileSync(CATALOG_PATH, JSON.stringify(catalogOut, null, 2) + '\n');
    process.stderr.write(`[capture] wrote ${CATALOG_PATH} (${allNames.length} tools)\n`);
  }
};

main().catch((err) => {
  process.stderr.write(`[capture] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
