/**
 * metadata_query routes through one of two transports depending on `kind`:
 *   - inner_tool transport (e.g. kind: 'fields', 'view_filters', 'view_fields')
 *     returns a RAW JSON array directly: [{...}, {...}].
 *   - graphql transport (e.g. kind: 'objects', 'workspaces') returns a wrapped
 *     object: { result: [{...}, {...}] }.
 * This helper accepts both shapes and returns the underlying array. Without it,
 * tests that hit kind: 'fields' / 'view_filters' silently get `[]` from
 * `parsed.result ?? []` and assertions trivially pass — the exact bug class
 * issue #7 was filed to eliminate (HIGH-2 from audit-round-1).
 *
 * Throws on unrecognised shapes instead of returning `[]` — a silent empty
 * result is indistinguishable from a genuinely empty workspace and would mask
 * a future Twenty API envelope change. Loud failure surfaces drift immediately.
 * If Twenty adds a new envelope shape, update this function and its tests.
 */
export const parseInnerOrGraphqlArray = <T>(text: string): T[] => {
  const raw: unknown = JSON.parse(text);
  if (Array.isArray(raw)) return raw as T[];
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { result?: unknown }).result)
  ) {
    return (raw as { result: T[] }).result;
  }
  const describe = (v: unknown): string => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object')
      return `object with keys [${Object.keys(v as object).join(', ')}]`;
    return typeof v;
  };
  throw new Error(
    `parseInnerOrGraphqlArray: unrecognised response shape — ` +
      `expected raw array or {result: [...]}; got ${describe(raw)}. ` +
      `If Twenty has added a new envelope shape, update parseInnerOrGraphqlArray in parse-metadata-array.ts.`,
  );
};
