import { parseInnerOrGraphqlArray } from '../utils/parse-metadata-array';

describe('parseInnerOrGraphqlArray', () => {
  it('unwraps a raw JSON array (inner_tool transport shape)', () => {
    const result = parseInnerOrGraphqlArray<{ a: number }>(
      JSON.stringify([{ a: 1 }, { a: 2 }]),
    );
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

  it('throws on unrecognised shapes (item 7: loud failure over silent empty)', () => {
    // {data: [...]} is a plausible future Twenty envelope shape — must throw, not return [].
    expect(() =>
      parseInnerOrGraphqlArray(JSON.stringify({ data: [1, 2, 3] })),
    ).toThrow(/unrecognised response shape/);
    expect(() =>
      parseInnerOrGraphqlArray(JSON.stringify({ data: [1, 2, 3] })),
    ).toThrow(/data/);
    expect(() =>
      parseInnerOrGraphqlArray(JSON.stringify({ notResult: 'x' })),
    ).toThrow(/unrecognised response shape/);
  });

  it('throws with the top-level keys in the error message (shape debugging aid)', () => {
    const err = (() => {
      try {
        parseInnerOrGraphqlArray(JSON.stringify({ rows: [1], total: 1 }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('rows');
    expect(err?.message).toContain('total');
    expect(err?.message).toContain('If Twenty has added a new envelope shape');
  });
});
