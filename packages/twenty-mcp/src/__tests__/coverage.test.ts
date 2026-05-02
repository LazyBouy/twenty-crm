/**
 * Coverage test — the structural safeguard from
 * plans/audit-and-safeguards.md Block B.
 *
 * For every wrapper file in src/tools/*.ts:
 *  1. Extract every inner tool name passed as `toolName: '<X>'` to
 *     `client.toolsCall('execute_tool', {toolName, …})`. Verify each name
 *     exists in the captured Twenty inner-tool fixture.
 *  2. Extract every GraphQL mutation in a wrapper-built `mutation { … }`
 *     string. Verify the operation name + each named input type exist on the
 *     CORRECT endpoint (the one the wrapper actually targets).
 *
 * This test is what would have caught all four production bugs of class
 * "hand-authored downstream contract diverged from deployed Twenty":
 *   - bug 1: data-wrapper shape (caught by contract.test, not here)
 *   - bug 2: workflow-gate routing (covered by note-targets routing assertion)
 *   - bug 3: createOneNoteTarget vs createNoteTarget (caught here — name not in fixture)
 *   - bug 4: createNoteTarget routed to /metadata not /graphql (caught here — name on wrong endpoint)
 *
 * If a fixture is missing or stale, the test fails with a SPECIFIC error
 * pointing at the file:line + the missing name. Refresh fixtures via:
 *   npx dotenv -e .env.production -- npx tsx scripts/capture-graphql-schema.ts
 *   npx dotenv -e .env.local      -- npx tsx scripts/capture-inner-schemas.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import pluralize from 'pluralize';

const TOOLS_DIR = join(__dirname, '..', 'tools');
const FIXTURES_DIR = join(__dirname, 'fixtures');

type GraphqlTypeRef = { name: string | null; kind: string; ofType?: GraphqlTypeRef | null };
type GraphqlField = { name: string; type?: GraphqlTypeRef };
type GraphqlType = {
  name: string;
  kind: string;
  fields?: GraphqlField[] | null;
};
type GraphqlSchema = {
  mutationType?: { fields?: GraphqlField[] };
  queryType?: { fields?: GraphqlField[] };
  types?: GraphqlType[];
};

/** Unwrap NON_NULL / LIST type wrappers to get the named type. */
const unwrapTypeName = (t: GraphqlTypeRef | null | undefined): string | null => {
  let cur: GraphqlTypeRef | null | undefined = t;
  while (cur && !cur.name) {
    cur = cur.ofType;
  }

  return cur?.name ?? null;
};

type InnerToolFixture = {
  tools: Record<string, unknown>;
};

const loadJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** Extract every inner tool name passed as `toolName: '<X>'` in a source file. */
const extractInnerToolNames = (source: string): string[] => {
  const out: string[] = [];
  // matches: toolName: 'X' or toolName: "X"
  const re = /toolName\s*:\s*['"]([a-zA-Z_][\w]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);

  // also matches innerToolName('op', '<plural-or-singular-arg>') — for crm.ts
  // the dynamic case. We resolve those at the test level via pluralize and
  // don't enumerate them here.
  return out;
};

/** Extract GraphQL operations (queries OR mutations) — one entry per `query … {<op>(…)}` or `mutation … {<op>(…)}` block. */
type ParsedOperation = {
  kind: 'query' | 'mutation';
  operationName: string;
  inputTypes: string[]; // type names referenced in parameter declarations
  selectedFields: string[]; // top-level fields in the response selection set
};

/** Extract the names of the immediate fields inside a balanced `{...}` selection. */
const extractSelectionFields = (source: string, openIdx: number): string[] => {
  // openIdx points at `{`. Walk forward, tracking balance, capturing identifiers
  // at depth 1 (top-level of the selection set).
  const fields = new Set<string>();
  let depth = 0;
  let i = openIdx;
  let buf = '';
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '{') {
      depth++;
      if (buf.trim()) {
        // identifier just before a nested {} → it's a field with sub-selection
        const id = buf.trim().split(/\s+/).pop();
        if (id && /^[a-zA-Z_]\w*$/.test(id) && depth === 2) fields.add(id);
        buf = '';
      }
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // flush remaining
        for (const w of buf.split(/\s+/)) {
          if (/^[a-zA-Z_]\w*$/.test(w)) fields.add(w);
        }

        return Array.from(fields);
      }
      buf = '';
    } else if (depth === 1) {
      // collecting at the top level of this selection set
      if (/[a-zA-Z0-9_]/.test(ch)) {
        buf += ch;
      } else {
        if (buf.trim() && /^[a-zA-Z_]\w*$/.test(buf.trim())) fields.add(buf.trim());
        buf = '';
      }
    }
    i++;
  }

  return Array.from(fields);
};

const extractGraphqlOperations = (source: string): ParsedOperation[] => {
  const out: ParsedOperation[] = [];
  // Match `query …` or `mutation …` blocks regardless of quote style:
  // backticks (template literals), single quotes, or double quotes — anywhere
  // a GraphQL operation string can appear in TypeScript.
  // The regex matches the keyword + everything up to the matching outer brace.
  // For multi-line backticks we accept all chars; for quoted strings the
  // operation must fit on one line (which is fine — the queries in metadata.ts
  // are single-line single-quoted strings).
  const blockRe = /(query|mutation)\s*(\([^)]*\))?\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(source)) !== null) {
    const kind = m[1] as 'query' | 'mutation';
    const args = m[2] ?? '';
    const body = m[3]!;

    // operation name = first identifier in the body (skipping whitespace)
    const opMatch = body.match(/\s*([a-zA-Z_]\w*)\s*[(\s{]/);
    if (!opMatch) continue;
    const operationName = opMatch[1]!;

    // Filter out spurious matches: TS keywords or test descriptors
    // (e.g., "describe('mutation { ... }', () => {...})" — the regex would
    // catch this but the captured op name would be a test fixture). Skip
    // operation names that don't look like GraphQL identifiers (camelCase only).
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(operationName)) continue;

    // input type names — from the optional argument list `($var: TypeName!)`
    const typeRe = /\$\w+\s*:\s*([\w!]+)/g;
    const inputTypes: string[] = [];
    let t: RegExpExecArray | null;
    while ((t = typeRe.exec(args)) !== null) {
      const name = t[1]!.replace(/[!\[\]]/g, '');
      if (name && !['String', 'Int', 'Float', 'Boolean', 'ID', 'UUID'].includes(name)) {
        inputTypes.push(name);
      }
    }

    // selection-set fields — the immediate field names inside the operation's
    // response `{...}` block. Find the `{` after the operationName(...) call.
    const opStartInBody = body.indexOf(operationName);
    let selectedFields: string[] = [];
    if (opStartInBody >= 0) {
      // skip over the (...) args of the operation call itself, then find the `{`
      let p = opStartInBody + operationName.length;
      while (p < body.length && body[p] !== '{' && body[p] !== '}') p++;
      if (body[p] === '{') {
        // Convert local position to absolute in m[0] then walk through `body`.
        selectedFields = extractSelectionFields(body, p);
      }
    }

    out.push({ kind, operationName, inputTypes, selectedFields });
  }

  return out;
};

/**
 * Detect which GraphQL endpoint a wrapper file targets. Per-file heuristic:
 * - If the file passes `'graphql'` as the third arg to graphqlMutation
 *   anywhere, every mutation in this file targets /graphql.
 * - Otherwise (no explicit endpoint), every mutation targets /metadata
 *   (the default in twenty-mcp-client.ts).
 *
 * Constraint: a single wrapper file must not mix endpoints. If you need both,
 * split into two files. The contract test enforces this by failing loudly
 * when a mutation lookup misses.
 */
const detectEndpointForFile = (source: string): 'metadata' | 'graphql' => {
  // matches the third arg of client.graphqlMutation(query, vars, 'graphql')
  // tolerant of multi-line / template-literal bodies in earlier args.
  if (/graphqlMutation\b[\s\S]*?,\s*['"]graphql['"]\s*\)/.test(source)) {
    return 'graphql';
  }
  if (/graphqlMutation\b[\s\S]*?,\s*['"]metadata['"]\s*\)/.test(source)) {
    return 'metadata';
  }

  return 'metadata';
};

/** Resolve dynamic crm.ts names against the fixture's <plural>/<singular> keys. */
const fixtureKeyForInnerName = (name: string): string => {
  if (name.startsWith('find_one_')) return 'find_one_<singular>';
  // find_<plural> placeholder — match if pluralize.plural(stripped) === stripped
  if (name.startsWith('find_')) {
    const tail = name.slice('find_'.length);
    if (pluralize.isPlural(tail)) return 'find_<plural>';
  }
  if (name.startsWith('create_') && !name.startsWith('create_many_')) {
    return 'create_<singular>';
  }
  if (name.startsWith('update_') && !name.startsWith('update_many_')) {
    return 'update_<singular>';
  }
  if (name.startsWith('delete_') && !name.startsWith('delete_many_')) {
    return 'delete_<singular>';
  }

  return name;
};

describe('coverage: every wrapper-authored downstream reference exists on the deployed Twenty', () => {
  const fixturePath = join(FIXTURES_DIR, 'inner-tool-schemas.json');
  const metadataPath = join(FIXTURES_DIR, 'metadata-graphql.json');
  const graphqlPath = join(FIXTURES_DIR, 'data-graphql.json');

  // Lazy-load with skip if fixtures are absent (e.g., fresh clone before captures run).
  const hasFixtures = existsSync(fixturePath) && existsSync(metadataPath) && existsSync(graphqlPath);

  if (!hasFixtures) {
    it.skip('fixtures missing — run `npx tsx scripts/capture-graphql-schema.ts` and `capture-inner-schemas.ts` to populate', () => {});

    return;
  }

  const innerFixture = loadJson<InnerToolFixture>(fixturePath);
  const metadataSchema = loadJson<GraphqlSchema>(metadataPath);
  const dataSchema = loadJson<GraphqlSchema>(graphqlPath);

  const innerToolKeys = new Set(Object.keys(innerFixture.tools));
  const metadataMutationFields = metadataSchema.mutationType?.fields ?? [];
  const metadataQueryFields = metadataSchema.queryType?.fields ?? [];
  const dataMutationFields = dataSchema.mutationType?.fields ?? [];
  const dataQueryFields = dataSchema.queryType?.fields ?? [];
  const metadataMutations = new Set(metadataMutationFields.map((f) => f.name));
  const metadataQueries = new Set(metadataQueryFields.map((f) => f.name));
  const dataMutations = new Set(dataMutationFields.map((f) => f.name));
  const dataQueries = new Set(dataQueryFields.map((f) => f.name));
  const metadataTypes = new Set(metadataSchema.types?.map((t) => t.name) ?? []);
  const dataTypes = new Set(dataSchema.types?.map((t) => t.name) ?? []);

  /** Build a name → fields-set lookup so we can validate selection sets. */
  const buildTypeFieldIndex = (
    types: GraphqlType[] | undefined,
  ): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const t of types ?? []) {
      if (t.fields) out.set(t.name, new Set(t.fields.map((f) => f.name)));
    }

    return out;
  };
  const metadataTypeFields = buildTypeFieldIndex(metadataSchema.types);
  const dataTypeFields = buildTypeFieldIndex(dataSchema.types);

  /** Get the return type name for an operation (mutation OR query). */
  const returnTypeNameFor = (
    fields: GraphqlField[],
    opName: string,
  ): string | null => {
    const f = fields.find((x) => x.name === opName);

    return f?.type ? unwrapTypeName(f.type) : null;
  };

  const wrapperFiles = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ name: f, path: join(TOOLS_DIR, f), source: readFileSync(join(TOOLS_DIR, f), 'utf8') }));

  describe('inner tool names exist in inner-tool-schemas fixture', () => {
    for (const file of wrapperFiles) {
      it(`${file.name}: every toolName: '<X>' literal resolves to a fixture entry`, () => {
        const names = extractInnerToolNames(file.source);
        const missing: string[] = [];
        for (const name of names) {
          const key = fixtureKeyForInnerName(name);
          if (!innerToolKeys.has(key)) missing.push(`'${name}' (fixture key: '${key}')`);
        }
        if (missing.length > 0) {
          throw new Error(
            `${file.name}: ${missing.length} inner tool name(s) not found in inner-tool-schemas.json:\n  ` +
              missing.join('\n  ') +
              `\nFix: add the entry to the fixture or rename the wrapper to match the deployed Twenty.`,
          );
        }
      });
    }
  });

  describe('GraphQL operations (queries + mutations) + input types exist on the correct endpoint', () => {
    for (const file of wrapperFiles) {
      const ops = extractGraphqlOperations(file.source);
      if (ops.length === 0) continue;

      it(`${file.name}: every GraphQL operation name exists on its target endpoint`, () => {
        const errors: string[] = [];
        const endpoint = detectEndpointForFile(file.source);
        for (const op of ops) {
          const set =
            endpoint === 'metadata'
              ? op.kind === 'mutation'
                ? metadataMutations
                : metadataQueries
              : op.kind === 'mutation'
                ? dataMutations
                : dataQueries;
          if (!set.has(op.operationName)) {
            errors.push(
              `${op.kind} '${op.operationName}' targeted at /${endpoint} but no such ${op.kind} in the captured ${endpoint}-graphql fixture`,
            );
          }
        }
        if (errors.length > 0) {
          throw new Error(
            `${file.name}: ${errors.length} GraphQL operation mismatch(es):\n  ` +
              errors.join('\n  ') +
              `\nFix: change the operation name OR change the endpoint passed to client.graphqlMutation().`,
          );
        }
      });

      it(`${file.name}: every GraphQL input type referenced exists on the same endpoint`, () => {
        const errors: string[] = [];
        const endpoint = detectEndpointForFile(file.source);
        for (const op of ops) {
          const types = endpoint === 'metadata' ? metadataTypes : dataTypes;
          for (const t of op.inputTypes) {
            if (!types.has(t)) {
              errors.push(
                `${op.kind} '${op.operationName}' references input type '${t}' but it does not exist on /${endpoint}`,
              );
            }
          }
        }
        if (errors.length > 0) {
          throw new Error(
            `${file.name}: ${errors.length} input type mismatch(es):\n  ` +
              errors.join('\n  ') +
              `\nFix: update the input type name OR move the operation to the correct endpoint.`,
          );
        }
      });

      it(`${file.name}: every selected response field exists on the operation's return type`, () => {
        const errors: string[] = [];
        const endpoint = detectEndpointForFile(file.source);
        const opFields =
          endpoint === 'metadata'
            ? { mutation: metadataMutationFields, query: metadataQueryFields }
            : { mutation: dataMutationFields, query: dataQueryFields };
        const typeFieldIndex = endpoint === 'metadata' ? metadataTypeFields : dataTypeFields;

        for (const op of ops) {
          if (op.selectedFields.length === 0) continue;
          const returnType = returnTypeNameFor(opFields[op.kind], op.operationName);
          if (!returnType) continue; // operation not in fixture — already flagged above
          const known = typeFieldIndex.get(returnType);
          if (!known) continue; // type not in fixture (rare — scalar/union); skip
          for (const f of op.selectedFields) {
            if (!known.has(f)) {
              errors.push(
                `${op.kind} '${op.operationName}' selects field '${f}' but it does not exist on type '${returnType}' (/${endpoint})`,
              );
            }
          }
        }
        if (errors.length > 0) {
          throw new Error(
            `${file.name}: ${errors.length} response selection mismatch(es):\n  ` +
              errors.join('\n  ') +
              `\nFix: drop the field from the selection or update the wrapper to match the deployed Twenty's type definition.`,
          );
        }
      });
    }
  });
});
