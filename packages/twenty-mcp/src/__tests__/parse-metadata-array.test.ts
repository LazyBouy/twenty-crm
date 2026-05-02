import { parseInnerOrGraphqlArray } from '../utils/parse-metadata-array';

describe('parseInnerOrGraphqlArray', () => {
  it('unwraps a raw JSON array (inner_tool transport shape)', () => {
    const result = parseInnerOrGraphqlArray<{ a: number }>(JSON.stringify([{ a: 1 }, { a: 2 }]));
    expect(result).toHaveLength(2);
    expect(result[0]?.a).toBe(1);
  });

  it('unwraps {result: [...]} (graphql transport shape)', () => {
    const result = parseInnerOrGraphqlArray<{ a: number }>(
      JSON.stringify({ result: [{ a: 1 }, { a: 2 }] }),
    );
    expect(result).toHaveLength(2);
    expect(result[1]?.a).toBe(2);
  });

  it('returns [] for unrecognised shapes', () => {
    expect(parseInnerOrGraphqlArray(JSON.stringify({ notResult: 'x' }))).toEqual([]);
    expect(parseInnerOrGraphqlArray(JSON.stringify(null))).toEqual([]);
    expect(parseInnerOrGraphqlArray(JSON.stringify('string'))).toEqual([]);
  });
});
