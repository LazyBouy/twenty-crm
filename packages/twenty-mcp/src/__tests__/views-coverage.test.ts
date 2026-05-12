/**
 * views-coverage.test.ts
 *
 * Structural safeguard: verifies that the wrapper's FIELD_TYPE_OPERAND_MAP is
 * byte-for-byte equivalent to twenty-front's FILTER_OPERANDS_MAP.
 *
 * When twenty-front adds a new field type or changes an operand list, this test
 * fails CI and forces a sync. This prevents the class of bug where the wrapper
 * accepts an operand that the UI cannot render (and crashes the page).
 *
 * Ground truth file:
 *   packages/twenty-front/src/modules/object-record/record-filter/utils/getRecordFilterOperands.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIELD_TYPE_OPERAND_MAP } from '../tools/views';

/**
 * Extracts the inner content of a balanced-bracket array starting at `openPos`
 * in `source`. `openPos` must point at the opening `[`. Returns the content
 * between the opening `[` and its matching `]` (exclusive of the brackets).
 * Throws if no matching `]` is found (unbalanced input).
 */
export const sliceBalancedBracket = (
  source: string,
  openPos: number,
): string => {
  let depth = 0;
  let end = openPos;
  for (let i = openPos; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        return source.slice(openPos + 1, end);
      }
    }
  }
  throw new Error(
    `sliceBalancedBracket: no matching ']' found starting at position ${openPos}`,
  );
};

// Path from this file to the twenty-front ground truth.
// __dirname is packages/twenty-mcp/src/__tests__
// 3 levels up: packages/twenty-mcp/src → packages/twenty-mcp → packages
// then: packages/twenty-front/src/...
const TWENTY_FRONT_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'twenty-front',
  'src',
  'modules',
  'object-record',
  'record-filter',
  'utils',
  'getRecordFilterOperands.ts',
);

describe('FIELD_TYPE_OPERAND_MAP matches twenty-front FILTER_OPERANDS_MAP', () => {
  if (!existsSync(TWENTY_FRONT_SOURCE)) {
    // Loud alarm: if source file moved/renamed, CI fails immediately (not silently skipped).
    throw new Error(
      'twenty-front source file missing or moved — update TWENTY_FRONT_SOURCE path in ' +
        'views-coverage.test.ts. Expected: ' +
        TWENTY_FRONT_SOURCE,
    );
  }

  const source = readFileSync(TWENTY_FRONT_SOURCE, 'utf8');

  // Parse FILTER_OPERANDS_MAP from twenty-front's source using regex.
  // Strategy: find the export const FILTER_OPERANDS_MAP = { ... } block and
  // extract each TYPE: [...] entry. Uses a balanced-brace scan for robustness.
  const parseTwentyFrontMap = (): Record<string, string[]> => {
    // Find the start of FILTER_OPERANDS_MAP object literal
    const startMatch = source.match(
      /export const FILTER_OPERANDS_MAP\s*=\s*\{/,
    );
    if (!startMatch || startMatch.index === undefined) {
      throw new Error(
        'Could not find FILTER_OPERANDS_MAP in twenty-front source',
      );
    }
    const braceStart = source.indexOf(
      '{',
      startMatch.index + startMatch[0].length - 1,
    );

    // Walk forward to find the matching closing brace
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const block = source.slice(braceStart, end + 1);

    // Extract TYPE: [...operands...] entries.
    // The pattern matches: IDENTIFIER: [...] possibly spanning multiple lines.
    // We use a stateful approach to handle multi-line arrays with spread operators.
    const result: Record<string, string[]> = {};

    // Match each top-level key (field type name) and its value (array)
    // The value may span multiple lines and contain ...emptyOperands / ...relationOperands spreads.
    const keyRe = /^\s{2}([A-Z_]+)\s*:\s*\[/gm;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(block)) !== null) {
      const fieldType = keyMatch[1]!;
      // Find the opening bracket position
      const arrayStart = block.indexOf(
        '[',
        keyMatch.index + keyMatch[0].length - 1,
      );
      // Walk forward to find matching ]
      let arrDepth = 0;
      let arrEnd = arrayStart;
      for (let i = arrayStart; i < block.length; i++) {
        if (block[i] === '[') arrDepth++;
        else if (block[i] === ']') {
          arrDepth--;
          if (arrDepth === 0) {
            arrEnd = i;
            break;
          }
        }
      }
      const arrContent = block.slice(arrayStart + 1, arrEnd);

      // Extract operand names — handles RecordFilterOperand.X and spread ...emptyOperands / ...relationOperands
      const operands: string[] = [];

      // Handle RecordFilterOperand.X references
      const opRe = /RecordFilterOperand\.([A-Z_]+)/g;
      let opMatch: RegExpExecArray | null;
      while ((opMatch = opRe.exec(arrContent)) !== null) {
        operands.push(opMatch[1]!);
      }

      // Handle spread operators: dynamically resolve any ...spreadName reference
      // by looking up the const declaration in the same source file.
      // Uses a balanced-bracket scan (not a non-greedy regex) so nested arrays
      // inside the spread const are handled correctly without a premature slice.
      const spreadRe = /\.\.\.([\w]+)/g;
      let spreadMatch: RegExpExecArray | null;
      while ((spreadMatch = spreadRe.exec(arrContent)) !== null) {
        const spreadName = spreadMatch[1]!;
        // Find `const <spreadName> = [` or `const <spreadName>: ... = [` header in source
        const headerRe = new RegExp(
          `const\\s+${spreadName}\\s*(?::[^=]+)?=\\s*\\[`,
        );
        const headerMatch = source.match(headerRe);
        if (!headerMatch || headerMatch.index === undefined) {
          throw new Error(
            `views-coverage: spread operator "...${spreadName}" found in FILTER_OPERANDS_MAP ` +
              `but no "const ${spreadName} = [...]" declaration found in the source file. ` +
              `Update the parser in views-coverage.test.ts to handle this spread.`,
          );
        }
        // Walk forward from the opening bracket using balanced-bracket scan.
        const bracketStart = source.indexOf(
          '[',
          headerMatch.index + headerMatch[0].length - 1,
        );
        // Extract RecordFilterOperand.X members from the spread declaration content.
        const spreadContent = sliceBalancedBracket(source, bracketStart);
        const spreadOpRe = /RecordFilterOperand\.([A-Z_]+)/g;
        let spreadOpMatch: RegExpExecArray | null;
        while ((spreadOpMatch = spreadOpRe.exec(spreadContent)) !== null) {
          operands.push(spreadOpMatch[1]!);
        }
      }

      result[fieldType] = operands;
    }

    return result;
  };

  it('balanced-bracket scanner correctly slices nested-array spread declarations (item 6 regression guard)', () => {
    // Confirms the balanced-bracket scan does NOT close on the first ] it finds.
    // A non-greedy [\s\S]*?\] regex would slice at the inner ] and return only
    // 'RecordFilterOperand.FIRST' — the scanner must return all three.
    // Calls the production sliceBalancedBracket helper (not an inline copy),
    // so any regression in the production code is caught here.
    const fakeSource = `
      const mySpread = [
        RecordFilterOperand.FIRST,
        [RecordFilterOperand.NESTED_INNER],
        RecordFilterOperand.THIRD,
      ];
    `;
    const headerMatch = fakeSource.match(
      /const\s+mySpread\s*(?::[^=]+)?=\s*\[/,
    );
    expect(headerMatch).not.toBeNull();
    const bracketStart = fakeSource.indexOf(
      '[',
      (headerMatch!.index ?? 0) + headerMatch![0].length - 1,
    );
    const content = sliceBalancedBracket(fakeSource, bracketStart);
    const found: string[] = [];
    const re = /RecordFilterOperand\.([A-Z_]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) found.push(m[1]!);
    // Must capture all three — not just the first (non-greedy regression).
    expect(found).toEqual(['FIRST', 'NESTED_INNER', 'THIRD']);
  });

  it('FIELD_TYPE_OPERAND_MAP has the same field types as FILTER_OPERANDS_MAP', () => {
    const twentyFrontMap = parseTwentyFrontMap();
    const wrapperTypes = Object.keys(FIELD_TYPE_OPERAND_MAP).sort();
    const frontTypes = Object.keys(twentyFrontMap).sort();
    expect(wrapperTypes).toEqual(frontTypes);
  });

  it('FIELD_TYPE_OPERAND_MAP has the same operand lists as FILTER_OPERANDS_MAP for every type', () => {
    const twentyFrontMap = parseTwentyFrontMap();
    const errors: string[] = [];
    for (const [fieldType, frontOperands] of Object.entries(twentyFrontMap)) {
      const wrapperOperands = FIELD_TYPE_OPERAND_MAP[fieldType];
      if (!wrapperOperands) {
        errors.push(
          `${fieldType}: present in twenty-front but missing in wrapper`,
        );
        continue;
      }
      const front = [...frontOperands].sort();
      const wrapper = [...wrapperOperands].sort();
      if (JSON.stringify(front) !== JSON.stringify(wrapper)) {
        errors.push(
          `${fieldType}: twenty-front has [${front.join(', ')}] but wrapper has [${wrapper.join(', ')}]`,
        );
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `FIELD_TYPE_OPERAND_MAP does not match twenty-front FILTER_OPERANDS_MAP:\n  ` +
          errors.join('\n  ') +
          `\n\nFix: update FIELD_TYPE_OPERAND_MAP in packages/twenty-mcp/src/tools/views.ts to match ` +
          `packages/twenty-front/src/modules/object-record/record-filter/utils/getRecordFilterOperands.ts`,
      );
    }
  });
});
