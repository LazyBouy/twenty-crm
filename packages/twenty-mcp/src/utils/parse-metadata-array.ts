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
 * Note: returns `[]` for unrecognised shapes (LOW-3 from audit-round-2 — silent
 * fail-empty foot-gun, accepted because the alternative is throwing in places
 * where callers should be defensive about response shape; tracked in low-backlog).
 */
export const parseInnerOrGraphqlArray = <T>(text: string): T[] => {
  const raw: unknown = JSON.parse(text);
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { result?: unknown }).result)) {
    return (raw as { result: T[] }).result;
  }
  return [];
};
