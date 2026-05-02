#!/usr/bin/env -S npx tsx
/**
 * capture-graphql-schema.ts
 *
 * Introspects both Twenty GraphQL endpoints (/metadata and /graphql) and writes
 * their schemas to fixtures. Used by coverage.test.ts to cross-check every
 * hand-authored mutation name + input type in the wrapper layer.
 *
 * Usage:
 *   npx dotenv -e .env.production -- npx tsx scripts/capture-graphql-schema.ts
 *
 * Outputs:
 *   src/__tests__/fixtures/metadata-graphql.json   — schema of /metadata
 *   src/__tests__/fixtures/data-graphql.json       — schema of /graphql
 *
 * Refresh on Twenty version bumps. Diff the result and commit.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'src', '__tests__', 'fixtures');

const INTROSPECTION_QUERY = `
query CaptureSchema {
  __schema {
    mutationType {
      name
      fields {
        name
        args { name type { name kind ofType { name kind ofType { name kind } } } }
        type { name kind ofType { name kind } }
      }
    }
    queryType {
      name
      fields {
        name
        args { name type { name kind ofType { name kind } } }
        type { name kind ofType { name kind } }
      }
    }
    types {
      name
      kind
      inputFields { name type { name kind ofType { name kind } } }
      fields { name type { name kind ofType { name kind } } }
      enumValues { name }
    }
  }
}`;

type IntrospectionResult = {
  data?: { __schema: unknown };
  errors?: Array<{ message: string }>;
};

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`[capture-graphql-schema] missing env var ${name}\n`);
    process.exit(1);
  }

  return v;
};

const introspect = async (endpoint: string, apiKey: string): Promise<unknown> => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${endpoint} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as IntrospectionResult;
  if (json.errors?.length) {
    throw new Error(`${endpoint} returned errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) throw new Error(`${endpoint} returned no data`);

  return json.data.__schema;
};

const main = async () => {
  const baseUrl = requireEnv('TWENTY_BASE_URL').replace(/\/+$/, '');
  const apiKey = requireEnv('TWENTY_API_KEY');

  for (const [name, path] of [
    ['metadata-graphql.json', '/metadata'],
    ['data-graphql.json', '/graphql'],
  ] as const) {
    process.stderr.write(`[capture-graphql-schema] introspecting ${baseUrl}${path}…\n`);
    const schema = await introspect(`${baseUrl}${path}`, apiKey);
    const out = join(FIXTURES, name);
    writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
    process.stderr.write(`[capture-graphql-schema] wrote ${out}\n`);
  }

  process.stderr.write('[capture-graphql-schema] done.\n');
};

main().catch((err) => {
  process.stderr.write(
    `[capture-graphql-schema] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
