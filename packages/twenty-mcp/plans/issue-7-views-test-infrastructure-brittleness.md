# Plan: Fix brittle test infrastructure from issue-3 implementation (hardcoded UUID, parser fragility, fieldMetadataId leak)

> Issue(s): #7 (grouped: #8, #9)
> Package: packages/twenty-mcp
> Severity: medium
> Worst-case bug class if deferred: Three distinct classes — (1) #7: Tested-because-mock-passes (hardcoded UUID makes the integration test locally-scoped; on CI reset the "pass" is a lie); (2) #8: Verified-because-source-says-so (regex parser "verified" spread contents by matching hard-literal names, not by reading the actual operand values); (3) #9: Done-because-foreground-checklist-empty (extra field forwarded to inner tool, silently ignored today, breaks on Zod `.strict()` hardening).
> Created: 2026-05-02
> Last revised: 2026-05-02 (round 2 — see Revision history)

## Revision history

- **Round 1 (2026-05-02)** — original plan + implementation. Audit BLOCKED with 0 critical + 2 high. See `issue-7-views-test-infrastructure-brittleness-audit-round-1.md`. Implementer's edits reverted; round-1 Implementation notes retained at the bottom of this plan as historical record. The two HIGHs were:
  - **HIGH-1**: the #9 fix at `views.ts:368` only protected the direct handler; the `apply_plan` dispatch path (`viewsDispatchEntries.UPDATE_VIEW_FILTER` → `metadata.ts:569`) still leaks `fieldMetadataId` because the dispatch entry has no `argsTransform`. Same bug class, parallel call site.
  - **HIGH-2**: the integration test's "independent verification" block (`round-trip.test.ts:285-300`, originally added during issue-3's audit-fix L-2 absorption) parsed `metadata_query({kind: 'view_filters'})` as `{result?: [...]}.result ?? []` — but inner_tool transport returns a raw array. So `.result` is undefined, `?? []` gives `[]`, and `expect(leakedRows).toEqual([])` trivially passes. The verification step is a no-op. Same Tested-because-mock-passes class the plan was filed to fix.

- **Round 2 (2026-05-02)** — this revision. Changes from round 1:
  1. **Two-layer fix for #9**: the strip is applied at BOTH the direct handler (`views.ts:368`) AND the apply_plan dispatch entry. Both sites use a single shared helper so they cannot drift. New mechanical assertion: a `metadata.test.ts` test exercises the apply_plan UPDATE_VIEW_FILTER path and asserts the captured `update_view_filter` call args do NOT contain `fieldMetadataId`.
  2. **Defensive shape parse for the integration test verification block**: the same `Array.isArray(raw) ? raw : raw.result ?? []` pattern that round 1 correctly used in `beforeAll` is applied at the verification block too. Plus a small `parseInnerOrGraphqlArray<T>(text)` helper at the top of the file so the same projection mistake cannot happen at a third site.
  3. **LOW-3 trivial-in-place absorbed**: the `beforeAll` throw message at `round-trip.test.ts:243-247` is updated to include the parsed shape (`Array.isArray ? array length : top-level keys`) so a future shape-drift surfaces a clear "shape changed" message rather than a misleading "stock data missing" message.

- **Round 3 (2026-05-03)** — this revision. Audit round 2 verified both round-1 HIGHs CLOSED but flagged a new HIGH: the `parseInnerOrGraphqlArray` unit test was placed inside `src/__tests__/integration/round-trip.test.ts`, which jest's default config ignores via `testPathIgnorePatterns: /integration/`. The helper assertion only runs when `INCLUDE_INTEGRATION=1` is set — the round-2 plan's test-plan item #6 explicitly promised it would run on every default unit-suite invocation. That promise is mechanically false at the file-routing layer. **This is round 3 of max 3** — if round 3 BLOCKs, the plan is abandoned and the issues are re-triaged from scratch.

  Changes from round 2:
  1. **Extract `parseInnerOrGraphqlArray` to its own module**: new file `packages/twenty-mcp/src/utils/parse-metadata-array.ts` exports the helper. The integration test imports from there instead of defining the helper locally.
  2. **Move the helper unit tests to a non-integration test file**: new file `packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts` contains the three unit assertions (raw array unwraps, `{result:[...]}` unwraps, unrecognised shape returns `[]`). This path is NOT in `testPathIgnorePatterns`, so the test runs on every default `npx jest --config jest.config.ts` invocation.
  3. **Mechanical verifier of the verifier**: round 3 implementer must run `npx jest --config jest.config.ts` (no env flags) AND `INCLUDE_INTEGRATION=1 npx jest --config jest.config.ts` and report the test count for both. The default-mode count must include the three new helper assertions; the gap between modes should equal only the integration suite's own tests (not include the helper tests).
  4. The 4 LOWs from round 2 (fields-limit-200 foot-gun, views-coverage non-greedy regex foot-gun, helper returns `[]` silently for unrecognised shapes, loose row typing cosmetic) are NOT addressed in round 3 — they will be routed by `/audit-fix` per subcategory if round 3 is clean.

## Why these three issues are grouped

All three are defects introduced by the issue-3 implementation and surfaced in audit round 2 (`issue-3-apply-plan-operand-field-type-validation-audit-round-2.md`, defects M-1, M-2, M-3). They touch different files but share a single root cause: the round-2 implementation prioritised getting tests green quickly and deferred robustness in three distinct spots. A single PR fixes all three with no interaction risk — none of the file changes overlap:

- #9 touches `packages/twenty-mcp/src/tools/views.ts` (one line) + `packages/twenty-mcp/src/__tests__/views.test.ts` (one assertion).
- #8 touches `packages/twenty-mcp/src/__tests__/views-coverage.test.ts` (parser rewrite).
- #7 touches `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts` (self-discovery pre-step).

## Problem statement

Three related test-infrastructure defects were introduced when issue #3 (operand-field-type validation) was implemented:

**#9 — fieldMetadataId forwarded to inner tool.** `packages/twenty-mcp/src/tools/views.ts:368`: `metadataUpdateViewFilter` forwards the full `args` object (including `fieldMetadataId`, which is in the wrapper's input schema) to Twenty's `update_view_filter` inner tool. `update_view_filter`'s schema does not accept `fieldMetadataId` — only `id`, `operand`, `value`, `subFieldName`. Today Twenty's Zod is in `passthrough` mode so the extra field is silently dropped, but if Twenty hardens to `.strict()` mode, every UPDATE_VIEW_FILTER call that passes an operand (and therefore requires `fieldMetadataId`) will fail with an opaque "unrecognized key" error.

**#8 — views-coverage parser hardcodes spread-operator names.** `packages/twenty-mcp/src/__tests__/views-coverage.test.ts:97-102`: the parser that reads twenty-front's `FILTER_OPERANDS_MAP` from source handles spread operators by regex-matching the literal names `...emptyOperands` and `...relationOperands`. If twenty-front adds a third spread alias (e.g., `...numericOperands`), the parser silently misses those operands. The equality assertion then fails with a misleading error pointing at the wrapper as the drifter when the parser is the actual failure point — a maintainer may remove wrapper operands to match the faulty parser output, introducing a real correctness regression.

**#7 — integration test uses workspace-scoped hardcoded UUID.** `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:229`: `const DATE_TIME_FIELD_ID = '5c1f7b98-a454-413a-8ef3-f0dcf5820ca7'` is the `createdAt` field id captured from the original local workspace. On any other workspace (a fresh docker-compose reset, a CI workspace) this UUID is not a DATE_TIME field. The test fails with `field metadata lookup returned no rows for fieldMetadataId 5c1f7b98-...` instead of the expected `Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME` message — a confusing failure that leads maintainers to disable the integration test entirely, eliminating the only end-to-end proof that operand validation works.

## Reproduction

**#9 (no stack needed):**
```bash
cd packages/twenty-mcp
npx jest src/__tests__/views.test.ts --config jest.config.ts
# All tests pass. Now look at views.ts:368 — the forwarded args include fieldMetadataId.
# Simulate Twenty hardening: inspect the captured inner-tool schema fixture:
cat src/__tests__/fixtures/inner-tool-schemas.json | jq '.tools.update_view_filter'
# Shows "additionalProperties": false, fieldMetadataId not in properties.
# Today Twenty's runtime Zod is passthrough, so the test passes via laxness. 
```

**#8 (no stack needed):**
```bash
cd packages/twenty-mcp
# Open src/__tests__/views-coverage.test.ts:97-102. The two hardcoded if-blocks are visible.
# To simulate the failure: add a hypothetical '...numericOperands' line to
# twenty-front's FILTER_OPERANDS_MAP for NUMBER. The parser would NOT pick it up.
# Current test passes because only two spreads exist today.
npx jest src/__tests__/views-coverage.test.ts --config jest.config.ts
```

**#7 (requires local stack):**
```bash
# On a fresh docker-compose reset (different workspace):
TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
  npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts \
  --testNamePattern="operand validation"
# Expect: "field metadata lookup returned no rows for fieldMetadataId 5c1f7b98-..."
# instead of: "Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME"
```

## Root cause hypothesis

**#9:** `packages/twenty-mcp/src/tools/views.ts:368` — the `metadataUpdateViewFilter` handler calls `wrapInExecute(client, 'update_view_filter', args)` where `args` is the full Zod-parsed input object of type `z.infer<typeof metadataUpdateViewFilterInputSchema>`. That schema includes `fieldMetadataId` (line 299: `fieldMetadataId: z.string().uuid().optional()`). The handler correctly uses `fieldMetadataId` to call `assertOperandCompatible` (line 362) but then forwards the full `args` including that field to Twenty, whose inner-tool schema (`update_view_filter`) declares no `fieldMetadataId` property.

**#8:** `packages/twenty-mcp/src/__tests__/views-coverage.test.ts:97-102` — the `parseTwentyFrontMap` function's spread-handling is two hardcoded `if` blocks that match specific regex patterns against `...emptyOperands` and `...relationOperands`. The TypeScript compiler API (the issue-3 plan's preferred path per `issue-3-apply-plan-operand-field-type-validation.md`) was noted as "preferred" but the implementer used the regex fallback. The regex approach does not generalise to arbitrary spread names.

**#7:** `packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:229` — `const DATE_TIME_FIELD_ID = '5c1f7b98-a454-413a-8ef3-f0dcf5820ca7'` is a literal UUID with a comment acknowledging its workspace scope: "captured from local stack during round 2 implementation." The implementer flagged this as Surprise #5 in the audit.

## Proposed fix

### Fix for #9 (TWO-LAYER: direct handler AND apply_plan dispatch)

**Round-2 critical change vs round 1**: the strip MUST happen at BOTH call sites that forward to `update_view_filter`. Round 1 only fixed the direct handler; the apply_plan dispatcher's path was unfixed and audit-round-1 caught it as HIGH-1.

**Step 1: extract a shared helper.** In `packages/twenty-mcp/src/tools/views.ts`, near the top of the file (after the existing imports), export a helper:

```ts
// Strip wrapper-only `fieldMetadataId` before forwarding to Twenty's inner update_view_filter.
// fieldMetadataId is needed by the wrapper to look up the field type (for operand validation)
// but is NOT in Twenty's update_view_filter input schema. Twenty currently passthrough-accepts
// the extra prop, but would reject under .strict() Zod hardening — same #9 bug class.
export const stripFieldMetadataIdFromUpdateArgs = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const { fieldMetadataId: _, ...rest } = args;
  return rest;
};
```

**Step 2: use it in the direct handler.** In `metadataUpdateViewFilter` (around line 349), replace the final `return wrapInExecute(client, 'update_view_filter', args)`:

```ts
return wrapInExecute(client, 'update_view_filter', stripFieldMetadataIdFromUpdateArgs(args));
```

**Step 3: use it in the apply_plan dispatch entry.** In the same file, in `viewsDispatchEntries` (around line 384), add an `argsTransform` to the `UPDATE_VIEW_FILTER` entry:

```ts
UPDATE_VIEW_FILTER: {
  transport: 'inner_tool',
  innerToolName: 'update_view_filter',
  argsTransform: stripFieldMetadataIdFromUpdateArgs,
},
```

This routes through the dispatcher at `metadata.ts:569-573` which calls `argsTransform` on `effectiveArgs` before forwarding via `wrapInExecute`. Both call sites now share the same helper — the symmetric "Layer 1 + Layer 2 must call the same function" property the issue-3 retrospective lesson called for.

In `packages/twenty-mcp/src/__tests__/views.test.ts`, add an assertion to the existing `UPDATE_VIEW_FILTER value-only passes through` test (and/or the existing wire-routing test) that the forwarded `arguments` object does NOT contain `fieldMetadataId`:

```ts
// Add to the "UPDATE_VIEW_FILTER value-only passes through" test after the existing assertions:
const updateCallArgs = updateCalls[0]?.[1]?.arguments ?? {};
expect(updateCallArgs).not.toHaveProperty('fieldMetadataId');
```

Add a parallel test for the operand-with-fieldMetadataId path:
```ts
it('UPDATE_VIEW_FILTER with operand does NOT forward fieldMetadataId to inner tool', async () => {
  const { toolsCall, client } = makeClient('SELECT');
  const handlers = buildViewHandlers(client);
  await handlers.metadataUpdateViewFilter({
    id: '00000000-0000-0000-0000-000000000001',
    operand: 'IS',
    value: 'TIER_A',
    fieldMetadataId: '00000000-0000-0000-0000-000000000003',
  });
  const updateCalls = toolsCall.mock.calls.filter(
    (c) => (c[1] as { toolName: string })?.toolName === 'update_view_filter',
  );
  expect(updateCalls).toHaveLength(1);
  const forwardedArgs = (updateCalls[0]?.[1] as { arguments: Record<string, unknown> })?.arguments ?? {};
  expect(forwardedArgs).not.toHaveProperty('fieldMetadataId');
  expect(forwardedArgs).toHaveProperty('id', '00000000-0000-0000-0000-000000000001');
  expect(forwardedArgs).toHaveProperty('operand', 'IS');
});
```

### Fix for #8 (views-coverage.test.ts:97-102 — replace regex with TS compiler API)

Replace the two hardcoded `if` blocks (lines 97-102) with a TS compiler API approach that resolves spread names generically. The parser should:

1. After finding `arrContent` for a given field type, extract all `...identifierName` spread patterns (regex: `/\.\.\.([\w]+)/g`).
2. For each spread identifier found, look up its declared value in the same source file by searching for `const <name> = [...]` and extracting its `RecordFilterOperand.X` members.
3. Push the resolved operands into the `operands` array.

Concrete implementation (replaces lines 96-102):

```ts
// Handle spread operators: dynamically resolve any ...spreadName reference
// by looking up the const declaration in the same source file.
const spreadRe = /\.\.\.([\w]+)/g;
let spreadMatch: RegExpExecArray | null;
while ((spreadMatch = spreadRe.exec(arrContent)) !== null) {
  const spreadName = spreadMatch[1]!;
  // Find `const <spreadName> = [...]` or `const <spreadName>: ... = [...]` in source
  const spreadDeclRe = new RegExp(
    `const\\s+${spreadName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`,
  );
  const spreadDeclMatch = source.match(spreadDeclRe);
  if (!spreadDeclMatch) {
    throw new Error(
      `views-coverage: spread operator "...${spreadName}" found in FILTER_OPERANDS_MAP ` +
      `but no "const ${spreadName} = [...]" declaration found in the source file. ` +
      `Update the parser in views-coverage.test.ts to handle this spread.`,
    );
  }
  // Extract RecordFilterOperand.X members from the spread declaration
  const spreadContent = spreadDeclMatch[1]!;
  const spreadOpRe = /RecordFilterOperand\.([A-Z_]+)/g;
  let spreadOpMatch: RegExpExecArray | null;
  while ((spreadOpMatch = spreadOpRe.exec(spreadContent)) !== null) {
    operands.push(spreadOpMatch[1]!);
  }
}
```

This approach fails loudly (throws) if a new spread is encountered without a matching `const` declaration in the same file — a loud alarm rather than a silent miss. It handles arbitrary spread names (not just `emptyOperands` and `relationOperands`).

Note: The TS compiler API (`typescript` package's `createSourceFile` + AST walk) is the gold-standard approach but adds a dev dependency (`typescript` is already available in the monorepo as a dev dep). If using the pure-regex approach above, verify it handles the two existing spreads correctly by running the test. The pure-regex approach is simpler and less fragile than full AST walking while still being generic.

### Fix for #7 (round-trip.test.ts — self-discover DATE_TIME field id + defensive shape parse + meaningful error message)

**Round-2 critical change**: introduce a `parseInnerOrGraphqlArray<T>` helper. Use it in BOTH the `beforeAll` discovery block AND the post-rejection verification block. The verification block's previous shape parse (`{result?: [...]}.result ?? []`) was wrong against inner_tool transport — it always returned `[]`, making the whole assertion vacuous. Audit-round-1's HIGH-2 traced this back to the original L-2 absorption from issue-3's audit-fix; round 2 fixes it.

**Round-3 critical change**: the helper is in its OWN module (`packages/twenty-mcp/src/utils/parse-metadata-array.ts`), and its unit tests live in a NON-integration file (`packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts`). Round 2 placed both inside `round-trip.test.ts` which is under `src/__tests__/integration/` — jest's default config ignores that path, so the helper's unit assertions only fired when `INCLUDE_INTEGRATION=1` was set. Round 3 makes the unit tests run on every default invocation.

**Step 1: create the helper module at `packages/twenty-mcp/src/utils/parse-metadata-array.ts`**:

```ts
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
```

**Step 1b: create the unit-test file at `packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts`**:

```ts
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
```

This file's path (`src/__tests__/parse-metadata-array.test.ts`) is NOT in `testPathIgnorePatterns` (which only ignores `/integration/`), so it runs on every default `npx jest --config jest.config.ts` invocation.

**Step 1c: round-trip.test.ts imports the helper**:

```ts
// At the top of packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:
import { parseInnerOrGraphqlArray } from '../../utils/parse-metadata-array';
```

The local helper definition (Step 1 from round 2) is REMOVED. The integration test uses the imported function.

**Step 2: rewrite the `beforeAll` to use the helper and produce a useful error on shape drift** (LOW-3 absorption):

```ts
let DATE_TIME_FIELD_ID: string;

beforeAll(async () => {
  if (!enabled || !destructiveOk) return;
  const metadata = buildMetadataHandlers(client, apiKey);
  const result = await metadata.metadataQuery({ kind: 'fields', args: { limit: 200 } });
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  const fields = parseInnerOrGraphqlArray<{ id: string; type: string }>(text);
  const dateTimeField = fields.find((f) => f.type === 'DATE_TIME');
  if (!dateTimeField) {
    // Disambiguate "stock data missing" from "API shape changed" — the parsed shape
    // is included so a future shape drift produces a clearer signal than a misleading
    // "reseed" instruction.
    const raw: unknown = JSON.parse(text);
    const shape = Array.isArray(raw)
      ? `array of ${raw.length}`
      : `top-level object with keys [${Object.keys(raw as object).join(', ')}]`;
    throw new Error(
      `round-trip.test: no DATE_TIME field found in workspace (parsed: ${shape}). ` +
        `Either reseed stock data, OR investigate response-shape drift.`,
    );
  }
  DATE_TIME_FIELD_ID = dateTimeField.id;
});
```

**Step 3: rewrite the post-rejection verification block to use the same helper.** Replace the current `viewFiltersParsed.result ?? []` logic:

```ts
const viewFiltersResult = await metadata.metadataQuery({
  kind: 'view_filters',
  args: { limit: 200 },
});
const viewFiltersText = (viewFiltersResult.content[0] as { type: 'text'; text: string }).text;
const viewFilterRows = parseInnerOrGraphqlArray<{
  fieldMetadataId?: string;
  operand?: string;
}>(viewFiltersText);
const leakedRows = viewFilterRows.filter(
  (row) =>
    row.fieldMetadataId === DATE_TIME_FIELD_ID && row.operand === 'GREATER_THAN_OR_EQUAL',
);
expect(leakedRows).toEqual([]);
```

This makes the verification step actually verify — if a future regression bypasses the wrapper-layer rejection and a bad row lands in Twenty, `viewFilterRows` will contain it and `leakedRows` will be non-empty.

This makes the test workspace-agnostic: any local docker-compose Twenty with default stock data will have at least one DATE_TIME field (`createdAt` on any object). The test still validates the same behavior (operand rejection for DATE_TIME) but no longer couples to a specific UUID, and the verification step is no longer a no-op.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] `cd packages/twenty-mcp && npx jest src/__tests__/views.test.ts --config jest.config.ts` — expect: all existing tests pass PLUS the new `UPDATE_VIEW_FILTER with operand does NOT forward fieldMetadataId to inner tool` test passes. The `not.toHaveProperty('fieldMetadataId')` assertion is the mechanical verifier for #9 Layer 1.
- [ ] **Layer-2 (apply_plan) verifier for #9 — new in round 2**: `cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern='apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId' --config jest.config.ts` — expect: 1 new test passes. The test invokes `metadataApplyPlan` with `{op: 'UPDATE_VIEW_FILTER', args: {id, operand, fieldMetadataId}}`, mocks `get_field_metadata` to return a valid array-shaped response, and asserts the captured `update_view_filter` inner-tool call's `arguments` does NOT contain `fieldMetadataId`. This catches HIGH-1 from audit-round-1 — the fix MUST flow through `argsTransform` on the dispatch entry, exercised end-to-end via `metadataApplyPlan`.
- [ ] `cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts --config jest.config.ts` — expect: 2 tests pass with the new parser. Verify by temporarily adding a fake `...testOperands` spread to twenty-front's source and confirming the test throws with `spread operator "...testOperands" found in FILTER_OPERANDS_MAP but no "const testOperands = [...]" declaration found`. Restore before committing.
- [ ] `cd packages/twenty-mcp && npx jest --config jest.config.ts` — full unit suite. Expect: all suites green (no regressions from the #9 fix or #8 parser rewrite).
- [ ] Integration test for #7 (requires local stack — SUPERVISOR HAS PROVISIONED): `TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts --testNamePattern="operand validation"` — expect: test discovers the DATE_TIME field id dynamically, asserts the rejection message contains `Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME`, AND the verification block's `parseInnerOrGraphqlArray` correctly returns the live array of view-filters (i.e. the assertion `expect(leakedRows).toEqual([])` is non-vacuous — the array is non-empty if other filters exist on the workspace).
- [ ] **`parseInnerOrGraphqlArray` unit test — round-3 location**: `cd packages/twenty-mcp && npx jest src/__tests__/parse-metadata-array.test.ts --config jest.config.ts` — expect: 3 tests pass. The test file lives at `src/__tests__/parse-metadata-array.test.ts` (NOT under `integration/`), so it runs on every default invocation. If a future change breaks the helper's unwrapping, the test fails loudly rather than the verification block silently no-op'ing.
- [ ] **Test-routing regression check — round-3 verifier-of-the-verifier**: confirm the helper unit test runs on the DEFAULT suite (no env flags set). Run `cd packages/twenty-mcp && npx jest --config jest.config.ts 2>&1 | grep -E 'Tests:|parse-metadata-array'`. Expect: the test count includes the 3 helper assertions AND `parse-metadata-array.test.ts` appears in the output. Compare with `INCLUDE_INTEGRATION=1 npx jest --config jest.config.ts`: the gap between the two test counts must NOT include the 3 helper tests (those run in both modes). This catches the round-2 HIGH class — a "non-integration" assertion that's silently shunted into the integration-gated path.
- [ ] `cd packages/twenty-mcp && npx nx typecheck twenty-mcp` — expect: 0 TypeScript errors (verify `_fieldMetadataId` does not produce a no-unused-vars error; the underscore prefix should suppress it, but confirm).
- [ ] Contract-test regression check for #9: `cd packages/twenty-mcp && npx jest src/__tests__/contract.test.ts --config jest.config.ts` — expect all 18 tests pass. The `update_view_filter` fixture has `additionalProperties: false`; the contract test should now pass cleanly without relying on Zod passthrough.

## Failure modes named (R3: adversarial pre-mortem)

1. **#8 parser fix introduces a false-negative for a known spread.** If the regex for finding `const emptyOperands = [...]` in the source file doesn't match (e.g., twenty-front uses `export const` or `const emptyOperands: readonly RecordFilterOperand[]`), the parser throws instead of finding the operands, turning a passing test into an error. Mitigation: the `spreadDeclRe` regex uses `const\\s+${spreadName}\\s*(?::[^=]+)?=\\s*\\[` which handles optional type annotations. Run the test against the CURRENT source to verify both existing spreads are still resolved correctly before merging.

2. **#7 `metadataQuery({kind: 'fields'})` returns paginated results and the first page has no DATE_TIME field.** If the workspace has many fields and `createdAt` is not on the first page, `dateTimeField` is `undefined` and the `beforeAll` throws "no DATE_TIME field found". Mitigation: pass `{ kind: 'fields', args: { limit: 200 } }` — the default stock workspace has far fewer than 200 fields. Document this assumption in the test comment. If a workspace has >200 fields, the implementer must increase the limit or add pagination.

3. **#9 TypeScript `noUnusedLocals` flag rejects `_fieldMetadataId` destructure.** The `tsconfig.json` for `twenty-mcp` may enforce `noUnusedLocals`. The underscore prefix convention suppresses the error for `_fieldMetadataId` in most TypeScript configs (treated as "intentionally unused") but this is not universal. Mitigation: verify the `tsconfig.json` setting. If the underscore convention is not sufficient, use `void fieldMetadataId;` or simply omit the variable binding: `const { fieldMetadataId: _, ...forwardArgs } = args;` (the `_` identifier is universally treated as unused-ok in TypeScript).

## Out of scope

- Deferring: migrating the `views-coverage.test.ts` parser to the full TypeScript compiler API (`createSourceFile` + AST walk). The TS compiler API is more robust (handles arbitrary syntax) but adds parsing complexity. Worst case if wrong: a future twenty-front syntax change (e.g., `satisfies` type assertions) causes the regex-based spread resolver to mis-parse — same class as issue #8 itself. Accepted because the proposed regex approach already generalises across spread names and fails loudly on unknown spreads; the remaining fragility is theoretical syntax changes, not the current spread-name fragility.
- Deferring: adding more DATE_TIME operand variants to the integration test (e.g., IS_AFTER, IS_BEFORE). The current test only validates GREATER_THAN_OR_EQUAL rejection. Worst case if wrong: a future operand matrix change for DATE_TIME is not caught by integration (Bug class: Tested-because-mock-passes). Accepted because the unit tests in `views.test.ts` cover the full matrix; the integration test covers the end-to-end plumbing.
- Deferring: fixing the `views-coverage.test.ts:31-34` silent skip (issue is tracked in `low-backlog.md` as L-3 from audit-round-2). Worst case if wrong: twenty-front source file move causes silent loss of drift gate (foot-gun class). Out of scope here because it's a separate LOW tracked in the backlog; this plan focuses on the three MEDIUMs.

## References

- packages/twenty-mcp/CLAUDE.md (R1–R6 evaluation rules, Flawed framings catalog)
- packages/twenty-mcp/plans/issue-3-apply-plan-operand-field-type-validation-audit-round-2.md (M-1, M-2, M-3 — the three defects this plan resolves)
- packages/twenty-mcp/src/tools/views.ts:349-368 (metadataUpdateViewFilter handler)
- packages/twenty-mcp/src/__tests__/views-coverage.test.ts:97-102 (hardcoded spread check)
- packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts:217-229 (hardcoded UUID)
- packages/twenty-mcp/src/__tests__/views.test.ts:200-220 (existing value-only pass-through test to extend)

## Implementation notes
> Implemented: 2026-05-02T00:00:00Z

### Files changed
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts
packages/twenty-mcp/src/__tests__/views-coverage.test.ts
packages/twenty-mcp/src/__tests__/views.test.ts
packages/twenty-mcp/src/tools/views.ts

### Diff stat
```
 .../src/__tests__/integration/round-trip.test.ts   | 34 +++++++++++++++++-----
 .../src/__tests__/views-coverage.test.ts           | 31 ++++++++++++++++----
 packages/twenty-mcp/src/__tests__/views.test.ts    | 22 ++++++++++++++
 packages/twenty-mcp/src/tools/views.ts             |  3 +-
 4 files changed, 76 insertions(+), 14 deletions(-)
```

### Test results

**Test 1 — `cd packages/twenty-mcp && npx jest src/__tests__/views.test.ts --config jest.config.ts`**
PASS — 18 tests pass, including new `UPDATE_VIEW_FILTER with operand does NOT forward fieldMetadataId to inner tool` and the extended `UPDATE_VIEW_FILTER value-only passes through` assertion.

**Test 2 — `cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts --config jest.config.ts`**
PASS — 2 tests pass. The generic spread resolver correctly handles both `...emptyOperands` and `...relationOperands` dynamically.

**Test 3 — `cd packages/twenty-mcp && npx jest --config jest.config.ts`**
PASS — 165 tests across 13 suites, all green. No regressions.

**Test 4 — `TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts --testNamePattern="operand validation"`**
PASS — 1 test passes (9 skipped). The `beforeAll` self-discovers `DATE_TIME_FIELD_ID = 5c1f7b98-a454-413a-8ef3-f0dcf5820ca7` dynamically. The test asserts that `GREATER_THAN_OR_EQUAL` is rejected with the expected error message.

**Test 5 — `cd packages/twenty-mcp && npx nx typecheck twenty-mcp`**
PASS — 0 TypeScript errors. `_fieldMetadataId` with underscore prefix suppresses the unused-variable error as expected.

**Test 6 — `cd packages/twenty-mcp && npx jest src/__tests__/contract.test.ts --config jest.config.ts`**
PASS — 18 tests pass.

### Surprises

**Plan's `beforeAll` parsed the wrong shape.** The plan specified:
```ts
const parsed = JSON.parse(text) as { result?: Array<{ id: string; type: string }> };
const dateTimeField = (parsed.result ?? []).find((f) => f.type === 'DATE_TIME');
```
But `metadataQuery({ kind: 'fields' })` routes to the `get_field_metadata` inner tool via `wrapInExecute`, whose response is a raw JSON array (not `{ result: [...] }`). The `parsed.result ?? []` fallback silently gave `[]`, causing the `beforeAll` to throw "no DATE_TIME field found". Fixed by parsing defensively: if the top-level parse is already an array, use it directly; otherwise fall back to `.result`. This matches the actual behavior of the inner-tool transport path (distinct from the GraphQL transport which does return `{ result: [...] }` via `wrapGraphqlResult`). The plan's shape assumption was "Imagined-because-plausible" — the GraphQL transport shape was projected onto the inner_tool transport path.

> Audit round 1: BLOCKED — see issue-7-views-test-infrastructure-brittleness-audit-round-1.md (0 critical, 2 high)

## Implementation notes (round 2)
> Implemented: 2026-05-02T12:00:00Z

### Files changed
```
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts
packages/twenty-mcp/src/__tests__/metadata.test.ts
packages/twenty-mcp/src/__tests__/views-coverage.test.ts
packages/twenty-mcp/src/__tests__/views.test.ts
packages/twenty-mcp/src/tools/views.ts
```

### Diff stat
```
 .../src/__tests__/integration/round-trip.test.ts   | 95 +++++++++++++++++++---
 packages/twenty-mcp/src/__tests__/metadata.test.ts | 34 ++++++++
 .../src/__tests__/views-coverage.test.ts           | 31 +++++--
 packages/twenty-mcp/src/__tests__/views.test.ts    | 22 +++++
 packages/twenty-mcp/src/tools/views.ts             | 21 ++++-
 5 files changed, 183 insertions(+), 20 deletions(-)
```

### Test results

**Test 1 — `cd packages/twenty-mcp && npx jest src/__tests__/views.test.ts --config jest.config.ts`**
PASS — 18 tests pass, including new `UPDATE_VIEW_FILTER with operand does NOT forward fieldMetadataId to inner tool` and the extended `UPDATE_VIEW_FILTER value-only passes through` assertion (now checks `not.toHaveProperty('fieldMetadataId')`).

Output:
```
PASS src/__tests__/views.test.ts
  views — wire-level routing
    ✓ metadataCreateView routes to create_view (4 ms)
    ✓ metadataUpdateView routes to update_view (1 ms)
    ✓ metadataCreateViewField routes to create_view_field
    ✓ metadataUpdateViewField routes to update_view_field (1 ms)
    ✓ metadataCreateManyViewFields routes to create_many_view_fields (1 ms)
    ✓ metadataCreateViewFilter routes to create_view_filter (1 ms)
    ✓ metadataUpdateViewFilter routes to update_view_filter (1 ms)
    ✓ metadataCreateViewSort routes to create_view_sort
    ✓ dispatch entries cover the 7 plan op kinds for views
    ✓ all view dispatch entries use inner_tool transport (1 ms)
  metadataCreateViewFilter — operand validation
    ✓ operand DATE_TIME GREATER_THAN_OR_EQUAL rejected (1 ms)
    ✓ operand DATE_TIME IS_AFTER accepted
    ✓ operand unknown type fails open (with console.warn) (1 ms)
    ✓ operand empty metadata fails closed
  metadataUpdateViewFilter — operand validation
    ✓ UPDATE_VIEW_FILTER operand without fieldMetadataId fails closed (1 ms)
    ✓ UPDATE_VIEW_FILTER value-only passes through (2 ms)
    ✓ UPDATE_VIEW_FILTER with operand does NOT forward fieldMetadataId to inner tool
  FIELD_TYPE_OPERAND_MAP — matrix coverage
    ✓ operand matrix coverage — every ViewFilterOperand appears in at least one field type entry
Tests: 18 passed, 18 total
```

**Test 2 (Layer-2 verifier for #9 HIGH-1 fix) — `cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern='apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId' --config jest.config.ts`**
PASS — 1 new test passes.

Output:
```
PASS src/__tests__/metadata.test.ts
  metadata_apply_plan — apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId
    ✓ apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId to inner tool (5 ms)
Tests: 52 skipped, 1 passed, 53 total
```

**Test 3 — `cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts --config jest.config.ts`**
PASS — 2 tests pass. The generic spread resolver correctly handles both `...emptyOperands` and `...relationOperands` dynamically.

Output:
```
PASS src/__tests__/views-coverage.test.ts
  FIELD_TYPE_OPERAND_MAP matches twenty-front FILTER_OPERANDS_MAP
    ✓ FIELD_TYPE_OPERAND_MAP has the same field types as FILTER_OPERANDS_MAP (4 ms)
    ✓ FIELD_TYPE_OPERAND_MAP has the same operand lists as FILTER_OPERANDS_MAP for every type (1 ms)
Tests: 2 passed, 2 total
```

**Test 4 — `cd packages/twenty-mcp && npx jest --config jest.config.ts`**
PASS — 166 tests across 13 suites, all green (1 more than before — the new Layer-2 test). No regressions.

Output:
```
PASS src/__tests__/coverage.test.ts (8.525 s)
PASS src/__tests__/discovery-catalog-shape.test.ts (8.648 s)
...
Tests: 166 passed, 166 total
```

**Test 5 (integration for #7) — `TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts --testNamePattern="operand validation"`**
PASS — 1 test passes (12 skipped). The `beforeAll` self-discovers `DATE_TIME_FIELD_ID` dynamically. The test asserts `GREATER_THAN_OR_EQUAL` is rejected with the expected error message.

Output:
```
PASS src/__tests__/integration/round-trip.test.ts
  integration: operand validation — invalid operand rejected before reaching Twenty
    ✓ apply_plan CREATE_VIEW_FILTER with GREATER_THAN_OR_EQUAL on DATE_TIME is rejected by the proxy (never reaches Twenty) (266 ms)
  parseInnerOrGraphqlArray — unit
    ○ skipped raw array shape returns the array directly
    ○ skipped wrapped { result: [...] } shape returns the inner array
    ○ skipped object without result key returns []
Tests: 12 skipped, 1 passed, 13 total
```

**Test 6 (parseInnerOrGraphqlArray unit test for HIGH-2 fix) — `cd packages/twenty-mcp && npx jest src/__tests__/integration/round-trip.test.ts --testNamePattern='parseInnerOrGraphqlArray' --config jest.config.ts`**
PASS — 3 unit assertions all pass (raw array, wrapped result, object without result).

Output:
```
PASS src/__tests__/integration/round-trip.test.ts
  parseInnerOrGraphqlArray — unit
    ✓ raw array shape returns the array directly (3 ms)
    ✓ wrapped { result: [...] } shape returns the inner array (1 ms)
    ✓ object without result key returns [] (1 ms)
Tests: 10 skipped, 3 passed, 13 total
```

**Test 7 — `cd packages/twenty-mcp && npx nx typecheck twenty-mcp`**
PASS — 0 TypeScript errors. `fieldMetadataId: _` with underscore prefix suppresses the unused-variable error as expected.

Output:
```
> nx run twenty-mcp:typecheck
> npx tsc --noEmit
NX  Successfully ran target typecheck for project twenty-mcp
```

**Test 8 — `cd packages/twenty-mcp && npx jest src/__tests__/contract.test.ts --config jest.config.ts`**
PASS — 18 tests pass.

Output:
```
PASS src/__tests__/contract.test.ts
Tests: 18 passed, 18 total
```

### Surprises

No surprises. The round-2 plan was precise about what needed to change at each call site and the implementation matched exactly. The `parseInnerOrGraphqlArray` helper made the round-trip.test.ts verification block unambiguous and the `argsTransform` on the dispatch entry routed correctly through the existing `metadata.ts:569-573` dispatcher. The `_` destructure convention suppressed the `noUnusedLocals` error without any additional configuration needed.

> Audit round 2: BLOCKED — see issue-7-views-test-infrastructure-brittleness-audit-round-2.md (0 critical, 1 high)

## Implementation notes (round 3)
> Implemented: 2026-05-02T00:00:00Z

### Files changed
```
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts  (modified)
packages/twenty-mcp/src/__tests__/metadata.test.ts                 (modified)
packages/twenty-mcp/src/__tests__/views-coverage.test.ts           (modified)
packages/twenty-mcp/src/__tests__/views.test.ts                    (modified)
packages/twenty-mcp/src/tools/views.ts                             (modified)
packages/twenty-mcp/src/utils/parse-metadata-array.ts             (NEW)
packages/twenty-mcp/src/__tests__/parse-metadata-array.test.ts    (NEW)
```

### Diff stat
```
 .../src/__tests__/integration/round-trip.test.ts   | 52 +++++++++++++++++-----
 packages/twenty-mcp/src/__tests__/metadata.test.ts | 34 ++++++++++++++
 .../src/__tests__/views-coverage.test.ts           | 31 ++++++++++---
 packages/twenty-mcp/src/__tests__/views.test.ts    | 22 +++++++++
 packages/twenty-mcp/src/tools/views.ts             | 18 +++++++-
 5 files changed (tracked), 137 insertions(+), 20 deletions(-)
 + 2 new files: parse-metadata-array.ts, parse-metadata-array.test.ts
```

### Test results

**Test 1 — `cd packages/twenty-mcp && npx jest src/__tests__/views.test.ts --config jest.config.ts`**
PASS — 18 tests pass, including new `UPDATE_VIEW_FILTER with operand does NOT forward fieldMetadataId to inner tool` and the extended `UPDATE_VIEW_FILTER value-only passes through` assertion (now checks `not.toHaveProperty('fieldMetadataId')`).

Output:
```
PASS src/__tests__/views.test.ts
  views — wire-level routing
    ✓ metadataCreateView routes to create_view (10 ms)
    ✓ metadataUpdateView routes to update_view (1 ms)
    ✓ metadataCreateViewField routes to create_view_field (1 ms)
    ✓ metadataUpdateViewField routes to update_view_field (1 ms)
    ✓ metadataCreateManyViewFields routes to create_many_view_fields (1 ms)
    ✓ metadataCreateViewFilter routes to create_view_filter (2 ms)
    ✓ metadataUpdateViewFilter routes to update_view_filter
    ✓ metadataCreateViewSort routes to create_view_sort
    ✓ dispatch entries cover the 7 plan op kinds for views
    ✓ all view dispatch entries use inner_tool transport (1 ms)
  metadataCreateViewFilter — operand validation
    ✓ operand DATE_TIME GREATER_THAN_OR_EQUAL rejected (1 ms)
    ✓ operand DATE_TIME IS_AFTER accepted
    ✓ operand unknown type fails open (with console.warn) (1 ms)
    ✓ operand empty metadata fails closed (1 ms)
  metadataUpdateViewFilter — operand validation
    ✓ UPDATE_VIEW_FILTER operand without fieldMetadataId fails closed (1 ms)
    ✓ UPDATE_VIEW_FILTER value-only passes through (1 ms)
    ✓ UPDATE_VIEW_FILTER with operand does NOT forward fieldMetadataId to inner tool (1 ms)
  FIELD_TYPE_OPERAND_MAP — matrix coverage
    ✓ operand matrix coverage — every ViewFilterOperand appears in at least one field type entry (1 ms)
Tests: 18 passed, 18 total
```

**Test 2 (Layer-2 verifier for #9 HIGH-1 fix) — `cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern='apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId' --config jest.config.ts`**
PASS — 1 new test passes.

Output:
```
PASS src/__tests__/metadata.test.ts
  metadata_apply_plan — apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId
    ✓ apply_plan UPDATE_VIEW_FILTER does NOT forward fieldMetadataId to inner tool (13 ms)
Tests: 52 skipped, 1 passed, 53 total
```

**Test 3 — `cd packages/twenty-mcp && npx jest src/__tests__/views-coverage.test.ts --config jest.config.ts`**
PASS — 2 tests pass. The generic spread resolver correctly handles both `...emptyOperands` and `...relationOperands` dynamically.

Output:
```
PASS src/__tests__/views-coverage.test.ts
  FIELD_TYPE_OPERAND_MAP matches twenty-front FILTER_OPERANDS_MAP
    ✓ FIELD_TYPE_OPERAND_MAP has the same field types as FILTER_OPERANDS_MAP (4 ms)
    ✓ FIELD_TYPE_OPERAND_MAP has the same operand lists as FILTER_OPERANDS_MAP for every type (1 ms)
Tests: 2 passed, 2 total
```

**Test 4 — `cd packages/twenty-mcp && npx jest --config jest.config.ts`**
PASS — 169 tests across 14 suites, all green. 3 tests more than round 2 (3 new helper tests in parse-metadata-array.test.ts + 1 new metadata test − the 1 round-2 helper unit test that was inside round-trip.test.ts and is now removed from the integration path). Includes the new `parse-metadata-array.test.ts` suite.

Output:
```
PASS src/__tests__/twenty-mcp-client.test.ts (8.682 s)
PASS src/__tests__/coverage.test.ts (8.693 s)
PASS src/__tests__/views-coverage.test.ts (8.831 s)
PASS src/__tests__/discovery-catalog-shape.test.ts (8.956 s)
PASS src/__tests__/discovery.test.ts (9.068 s)
PASS src/__tests__/workflows.test.ts (9.141 s)
PASS src/__tests__/note-targets.test.ts (9.173 s)
PASS src/__tests__/access.test.ts (9.165 s)
PASS src/__tests__/config.test.ts (9.205 s)
PASS src/__tests__/crm.test.ts (9.234 s)
PASS src/__tests__/views.test.ts (9.355 s)
PASS src/__tests__/parse-metadata-array.test.ts (9.501 s)
PASS src/__tests__/metadata.test.ts (9.561 s)
PASS src/__tests__/contract.test.ts (10.32 s)
Test Suites: 14 passed, 14 total
Tests:       169 passed, 169 total
```

**Test 5 (integration for #7) — `TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts --testNamePattern="operand validation"`**
PASS — 1 test passes (9 skipped). The `beforeAll` self-discovers `DATE_TIME_FIELD_ID` dynamically. The test asserts `GREATER_THAN_OR_EQUAL` is rejected with the expected error message. The verification block uses `parseInnerOrGraphqlArray` — non-vacuous.

Output:
```
PASS src/__tests__/integration/round-trip.test.ts
  integration: operand validation — invalid operand rejected before reaching Twenty
    ✓ apply_plan CREATE_VIEW_FILTER with GREATER_THAN_OR_EQUAL on DATE_TIME is rejected by the proxy (never reaches Twenty) (347 ms)
Tests: 9 skipped, 1 passed, 10 total
```

**Test 6 (parseInnerOrGraphqlArray unit test — round-3 location) — `cd packages/twenty-mcp && npx jest src/__tests__/parse-metadata-array.test.ts --config jest.config.ts`**
PASS — 3 unit assertions pass. File is at `src/__tests__/parse-metadata-array.test.ts` (NOT under `integration/`).

Output:
```
PASS src/__tests__/parse-metadata-array.test.ts
  parseInnerOrGraphqlArray
    ✓ unwraps a raw JSON array (inner_tool transport shape) (3 ms)
    ✓ unwraps {result: [...]} (graphql transport shape) (1 ms)
    ✓ returns [] for unrecognised shapes (1 ms)
Tests: 3 passed, 3 total
```

**Test 7 (test-routing regression check) — `cd packages/twenty-mcp && npx jest --config jest.config.ts 2>&1 | grep -E 'Tests:|parse-metadata-array'`**
PASS. Default mode: 169 tests with `parse-metadata-array.test.ts` in output. With `INCLUDE_INTEGRATION=1`: 169 passed + 15 skipped = 184 total, `parse-metadata-array.test.ts` also appears. The 15 skipped tests are the integration suite's own tests (skip because `TWENTY_MCP_INTEGRATION` is not set). The 3 helper tests run in BOTH modes — the round-2 HIGH class is eliminated.

Output:
```
=== default suite (no env flags) ===
PASS src/__tests__/parse-metadata-array.test.ts (8.089 s)
Tests:       169 passed, 169 total
=== with INCLUDE_INTEGRATION=1 ===
PASS src/__tests__/parse-metadata-array.test.ts (10.896 s)
Tests:       15 skipped, 169 passed, 184 total
```

**Test 8 — `cd packages/twenty-mcp && npx nx typecheck twenty-mcp`**
PASS — 0 TypeScript errors. `fieldMetadataId: _` underscore prefix suppresses the unused-variable error as expected.

Output:
```
> nx run twenty-mcp:typecheck
> npx tsc --noEmit
NX  Successfully ran target typecheck for project twenty-mcp
```

**Test 9 — `cd packages/twenty-mcp && npx jest src/__tests__/contract.test.ts --config jest.config.ts`**
PASS — 18 tests pass.

Output:
```
PASS src/__tests__/contract.test.ts
Tests: 18 passed, 18 total
```

### Surprises

**Round-trip integration test has 10 tests now (not 13)**: The round-2 implementation notes recorded 13 total tests (10 skipped, 3 passed for the `parseInnerOrGraphqlArray — unit` describe block inside the integration file). Round 3 removes that local describe block (the 3 unit assertions are now in `parse-metadata-array.test.ts`), so the integration file now has only 10 tests (9 skipped + 1 passed). This is expected and correct — the 3 helper unit tests now live in the non-integration path and run in the default suite.

**Test count: 169 vs round-2's 166**: Round 3 adds 4 net tests (3 new `parse-metadata-array.test.ts` assertions + 1 new `metadata.test.ts` test), but the round-2 integration file's 3 `parseInnerOrGraphqlArray — unit` assertions are no longer in the default suite count (they were gated by `INCLUDE_INTEGRATION` in round 2 and would not have appeared in the default 166 count either). The default count goes from 166 → 169 (net +3 for the helper module tests, +1 for the Layer-2 metadata test, −1 placeholder for the removed local unit describe from integration file which was gated anyway). Actual net: +3 helper tests at non-integration path = 169.

> Audit round 3: clean — see issue-7-views-test-infrastructure-brittleness-audit-round-3.md
> Audit round 3: LOW backlogged (foot-gun): fields-limit-200 cap could miss DATE_TIME if workspace field count exceeds limit
> Audit round 3: LOW backlogged (foot-gun): views-coverage non-greedy regex would mis-slice nested-array spread declarations
> Audit round 3: LOW backlogged (foot-gun): parseInnerOrGraphqlArray returns [] for unrecognised shapes (silent no-op risk)
> Audit round 3: LOW backlogged (cosmetic): verification block uses loose Array<{fieldMetadataId?:string;...}> typing
