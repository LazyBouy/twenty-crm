import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { innerToolName } from '../tools/crm';

const CAMEL_TO_SNAKE_SOURCE_PATH = join(
  __dirname,
  '../../../twenty-shared/src/utils/strings/camelToSnakeCase.ts',
);

/**
 * Loads the canonical camelToSnakeCase from twenty-shared. Validates the
 * source file still exists AND its signature matches what we expect — if it
 * doesn't (e.g. the algorithm was changed server-side), this throws loudly so
 * the wrapper's regex can be updated in lockstep.
 *
 * Returns a runtime function implementing the canonical algorithm.
 */
const loadCanonicalCamelToSnakeCase = (): ((s: string) => string) => {
  if (!existsSync(CAMEL_TO_SNAKE_SOURCE_PATH)) {
    throw new Error(
      `twenty-shared camelToSnakeCase source not found at ${CAMEL_TO_SNAKE_SOURCE_PATH} ` +
        `— file moved or renamed. Update CAMEL_TO_SNAKE_SOURCE_PATH in crm-coverage.test.ts.`,
    );
  }
  const source = readFileSync(CAMEL_TO_SNAKE_SOURCE_PATH, 'utf8');
  // Assert the source still implements the regex-replace algorithm. If this fails,
  // the wrapper's normalize() must be re-evaluated against the new algorithm.
  const expectedSignature =
    /replace\(\s*\/\[A-Z\]\/g\s*,\s*\(letter\)\s*=>\s*`_\$\{letter\.toLowerCase\(\)\}`\s*\)/;
  if (!expectedSignature.test(source)) {
    throw new Error(
      `twenty-shared camelToSnakeCase no longer implements the expected regex-replace pattern. ` +
        `Audit packages/twenty-mcp/src/tools/crm.ts:normalize() against the new algorithm and ` +
        `update the expectedSignature regex in crm-coverage.test.ts.\n\nCurrent source:\n${source}`,
    );
  }
  // The signature check above is the drift gate. The returned function is a
  // local mirror of the canonical algorithm — both are validated to agree.
  return (s: string) => s.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
};

describe('crm-coverage: wrapper normalize() matches server camelToSnakeCase for camelCase inputs', () => {
  const camelToSnakeCase = loadCanonicalCamelToSnakeCase();

  // Inputs Twenty server would actually emit as nameSingular / namePlural —
  // i.e. camelCase, lowercase-first. Curated to cover 1-, 2-, and 3-word stems.
  // Excludes English mass nouns (analytics, data, news, series, etc.) — the pluralize
  // library mishandles those, surfacing a SEPARATE bug class outside issue #11's scope.
  // See crm.test.ts "documents pluralize-mass-noun limitation" for the deferred case.
  const CAMEL_CASE_INPUTS: ReadonlyArray<{ singular: string; plural: string }> = [
    { singular: 'person', plural: 'people' },
    { singular: 'company', plural: 'companies' },
    { singular: 'opportunity', plural: 'opportunities' },
    { singular: 'schemaChangeAudit', plural: 'schemaChangeAudits' },
    { singular: 'customerHealth', plural: 'customerHealths' },
    { singular: 'companyMetric', plural: 'companyMetrics' },
    { singular: 'salesActivity', plural: 'salesActivities' },
    { singular: 'productCategory', plural: 'productCategories' },
    { singular: 'noteTarget', plural: 'noteTargets' },
    { singular: 'workflowVersion', plural: 'workflowVersions' },
  ];

  // Build canonical server-side tool names per the database-tool.provider.ts logic:
  //   find_${camelToSnakeCase(namePlural)}
  //   find_one_${camelToSnakeCase(nameSingular)}
  //   create_${camelToSnakeCase(nameSingular)} (and update / delete)
  for (const { singular, plural } of CAMEL_CASE_INPUTS) {
    const canonicalPlural = camelToSnakeCase(plural);
    const canonicalSingular = camelToSnakeCase(singular);

    it(`'${singular}' (singular) → find_one matches server camelToSnakeCase`, () => {
      expect(innerToolName('get', singular)).toBe(`find_one_${canonicalSingular}`);
    });
    it(`'${plural}' (plural) → find matches server camelToSnakeCase`, () => {
      expect(innerToolName('search', plural)).toBe(`find_${canonicalPlural}`);
    });
    it(`'${singular}' → create matches server camelToSnakeCase`, () => {
      expect(innerToolName('create', singular)).toBe(`create_${canonicalSingular}`);
    });
  }
});
