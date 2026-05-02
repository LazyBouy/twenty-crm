# Plan: metadata_apply_plan accepts invalid operand-for-field-type combos in CREATE_VIEW_FILTER, breaking the Twenty UI

> Issue(s): #3
> Package: packages/twenty-mcp
> Severity: high
> Worst-case bug class if deferred: Imagined-because-plausible — the operand enum is structurally correct (the value is a valid member), so the wrapper ships the filter to Twenty without complaint. The crash is deferred to the frontend, where it is silent at the API layer and catastrophic at the UI layer: the entire view-bearing page becomes unrenderable until the bad filter row is manually patched.
> Created: 2026-05-02

## Problem statement

`metadata_apply_plan`'s `CREATE_VIEW_FILTER` and `UPDATE_VIEW_FILTER` operations dispatch directly to Twenty's inner tools without validating that the supplied `operand` is compatible with the target field's type. The valid operand-by-field-type matrix is documented in the tool's description text but is not enforced at runtime. A caller can supply `operand: "GREATER_THAN_OR_EQUAL"` for a `DATE_TIME` field — structurally valid per the `ViewFilterOperand` enum but semantically invalid — and `apply_plan` returns `{ success: true }`. Twenty persists the row. When any user opens a view that includes this filter, the Twenty frontend raises `Sorry, something went wrong / Please refresh the page` on the view's page (because the filter widget does not know how to render a `GREATER_THAN_OR_EQUAL` operand for a `DATE_TIME` field). The failure is workspace-wide for `WORKSPACE`-visibility views.

## Reproduction

Using the real incident from 2026-05-01 (`lead-generation-tech-philosophy`):

```jsonc
// Single-mutation plan:
{
  "key": "create_view_filter__lastResearchAt_gte",
  "op": "CREATE_VIEW_FILTER",
  "args": {
    "viewId": "<any valid view UUID>",
    "fieldMetadataId": "336b0886-5dc7-48cf-8cd4-6754f446f865",  // lastResearchAt — DATE_TIME
    "operand": "GREATER_THAN_OR_EQUAL",                         // NOT valid for DATE_TIME
    "value": "2026-05-01T00:00:00.000Z"
  }
}
```

`metadata_apply_plan` returns `{ totalMutations: 1, applied: [...], failed: null }`. The filter row is persisted with `id: "9c16bd5f-..."`. Opening the Companies view page in the Twenty UI crashes.

To reproduce without a live stack at the unit level, demonstrate that no validation fires:

```bash
cd packages/twenty-mcp
npx jest --testPathPattern='views.test.ts' --testNamePattern='operand validation' --config jest.config.ts
# Expected BEFORE fix: no such test exists; the schema accepts GREATER_THAN_OR_EQUAL for any field.
# Expected AFTER fix: test enforces the field-type matrix at the handler layer.
```

Note: the live reproduction requires a running Twenty instance; the unit-level fix can be validated without one.

## Root cause hypothesis

Two places in the codebase share responsibility:

**Location 1 — `packages/twenty-mcp/src/tools/views.ts:150-169`** — `metadataCreateViewFilterInputSchema`:
```typescript
// views.ts:150-169
export const metadataCreateViewFilterInputSchema = z.object({
  viewId: z.string().uuid(),
  fieldMetadataId: z.string().uuid(),
  operand: ViewFilterOperand,          // ← flat enum, no field-type constraint
  value: z.union([...]),
  subFieldName: z.string().optional(),
});
```
The schema accepts any `ViewFilterOperand` member regardless of the field's type. There is no cross-field validation between `operand` and the field's `type` (which would require a runtime lookup of `fieldMetadataId` against the metadata catalog).

**Location 2 — `packages/twenty-mcp/src/tools/metadata.ts:449-469`** (the apply-plan dispatch loop):
The loop at line 449 resolves the dispatch entry and at lines 460-464 either runs `argsTransform` or passes `m.args` directly. There is no pre-dispatch validation step that checks semantic constraints (operand/field-type compatibility). The `APPLY_PLAN_DISPATCH` table (`metadata.ts:252-256`) maps `CREATE_VIEW_FILTER` to `{ transport: 'inner_tool', innerToolName: 'create_view_filter' }` with no validation hook.

**The valid operand matrix IS already documented** in `views.ts:277-283` (`metadata_create_view_filter` tool description text) but only as a prose description for the LLM agent. It is not enforced in code. The enforcement gap is entirely at the wrapper layer.

**A complicating factor**: validating `operand` against the field's `type` requires knowing the field's type, which is only derivable by calling `metadata_query({kind: "fields", args: {id: fieldMetadataId}})` — a network round-trip to Twenty. The wrapper currently does not do this lookup before dispatching.

## Proposed fix

### Layer 1 — enforce the matrix in `metadataCreateViewFilter` and `metadataUpdateViewFilter` handlers

In `packages/twenty-mcp/src/tools/views.ts`, update `buildViewHandlers` to add a validation helper that looks up the field's type and validates the operand before forwarding:

```typescript
// Operand compatibility matrix (mirrors the prose in the tool description).
const FIELD_TYPE_OPERAND_MAP: Record<string, readonly string[]> = {
  TEXT:         ['IS', 'IS_NOT', 'CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  EMAILS:       ['IS', 'IS_NOT', 'CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  FULL_NAME:    ['IS', 'IS_NOT', 'CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  NUMBER:       ['IS', 'IS_NOT', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  NUMERIC:      ['IS', 'IS_NOT', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  CURRENCY:     ['GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  DATE:         ['IS', 'IS_RELATIVE', 'IS_IN_PAST', 'IS_IN_FUTURE', 'IS_TODAY', 'IS_BEFORE', 'IS_AFTER', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  DATE_TIME:    ['IS', 'IS_RELATIVE', 'IS_IN_PAST', 'IS_IN_FUTURE', 'IS_TODAY', 'IS_BEFORE', 'IS_AFTER', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  SELECT:       ['IS', 'IS_NOT', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  MULTI_SELECT: ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  ARRAY:        ['CONTAINS', 'DOES_NOT_CONTAIN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  RELATION:     ['IS', 'IS_NOT', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  BOOLEAN:      ['IS'],
};

// Lookup field type from Twenty, then validate operand.
async function assertOperandCompatible(
  client: TwentyMcpClient,
  fieldMetadataId: string,
  operand: string,
): Promise<{ valid: true } | { valid: false; error: string }> {
  const result = await client.toolsCall('execute_tool', {
    toolName: 'get_field_metadata',
    arguments: { id: fieldMetadataId },
  });
  // Parse field type from result
  const text = (result.content[0] as { type: string; text: string } | undefined)?.text;
  if (!text) return { valid: true }; // can't validate without response — fail open with a warning
  const parsed = JSON.parse(text) as { type?: string } | { result?: { type?: string } };
  const fieldType =
    (parsed as { type?: string }).type ??
    ((parsed as { result?: { type?: string } }).result?.type);
  if (!fieldType) return { valid: true }; // unknown type — fail open
  const allowed = FIELD_TYPE_OPERAND_MAP[fieldType];
  if (!allowed) return { valid: true }; // type not in matrix — unknown type, fail open
  if (!allowed.includes(operand)) {
    return {
      valid: false,
      error: `Operand ${operand} is not valid for ${fieldType} field (id: ${fieldMetadataId}). Valid operands for ${fieldType}: ${allowed.join(', ')}.`,
    };
  }
  return { valid: true };
}
```

Then in `metadataCreateViewFilter` and `metadataUpdateViewFilter` handlers, call `assertOperandCompatible` before `wrapInExecute`. On failure, return a structured error with `isError: true` instead of forwarding.

### Layer 2 — enforce the matrix in `metadataApplyPlan` for CREATE_VIEW_FILTER / UPDATE_VIEW_FILTER

In `packages/twenty-mcp/src/tools/metadata.ts`, add a pre-dispatch validation hook specifically for view-filter ops. When `m.op` is `CREATE_VIEW_FILTER` or `UPDATE_VIEW_FILTER` and `m.args.operand` is provided, call `assertOperandCompatible` (extracted to a shared utility or duplicated in metadata.ts). On failure, set `failed` and break the loop — same semantics as a dispatch error.

### Decision: fail-CLOSED vs fail-OPEN for unknown field types

The `assertOperandCompatible` helper proposes fail-open for unknown field types (types not in the matrix). This is a deliberate trade-off: blocking all unknown types would prevent valid use of future Twenty field types. The matrix should be kept up to date as new field types are added to Twenty. The fail-open fallback must be clearly marked in code with a comment so future maintainers can close it when the matrix is complete.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] **Unit — `CREATE_VIEW_FILTER` with invalid operand for DATE_TIME returns an error before dispatching:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='views.test.ts' --testNamePattern='operand DATE_TIME GREATER_THAN_OR_EQUAL rejected' --config jest.config.ts
  ```
  New test: mock `toolsCall` for `get_field_metadata` to return `{ content: [{ type:'text', text:'{"type":"DATE_TIME"}' }] }`. Call `metadataCreateViewFilter` with `operand: 'GREATER_THAN_OR_EQUAL'`. Assert `result.isError === true` and the error text matches `/Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME/`. Assert the second `toolsCall` (for `create_view_filter`) was NOT called.

- [ ] **Unit — `CREATE_VIEW_FILTER` with valid operand for DATE_TIME dispatches normally:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='views.test.ts' --testNamePattern='operand DATE_TIME IS_AFTER accepted' --config jest.config.ts
  ```
  New test: same setup with `operand: 'IS_AFTER'`. Assert `toolsCall` IS called with `create_view_filter`.

- [ ] **Unit — `CREATE_VIEW_FILTER` for an unknown field type fails open (dispatches without blocking):**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='views.test.ts' --testNamePattern='operand unknown type fails open' --config jest.config.ts
  ```
  New test: mock `get_field_metadata` to return `{ type: "RICH_TEXT" }` (not in the matrix). Call with any operand. Assert `toolsCall` IS called with `create_view_filter` (fail-open semantics).

- [ ] **Unit — apply_plan with `CREATE_VIEW_FILTER` bad operand fails the plan at that step:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='metadata.test.ts' --testNamePattern='apply_plan CREATE_VIEW_FILTER operand rejected' --config jest.config.ts
  ```
  New test: two-mutation plan: `CREATE_VIEW` (mock success) followed by `CREATE_VIEW_FILTER` with `operand: 'GREATER_THAN_OR_EQUAL'` targeting a `DATE_TIME` field. Assert `parsed.failed.op === 'CREATE_VIEW_FILTER'`, `parsed.failed.error` matches `/Operand GREATER_THAN_OR_EQUAL is not valid for DATE_TIME/`, and `parsed.applied` has exactly the first mutation.

- [ ] **Unit — the FIELD_TYPE_OPERAND_MAP covers all operands in the ViewFilterOperand enum:**
  ```bash
  cd packages/twenty-mcp
  npx jest --testPathPattern='views.test.ts' --testNamePattern='operand matrix coverage' --config jest.config.ts
  ```
  New test: import `ViewFilterOperand` enum values and `FIELD_TYPE_OPERAND_MAP`. Assert that every operand in the enum appears in at least one field type's allowed list (no orphaned operand values that the matrix doesn't reference).

- [ ] **Full unit suite green:**
  ```bash
  cd packages/twenty-mcp
  npx jest --config jest.config.ts
  ```

- [ ] **Integration smoke — bad filter is blocked before reaching Twenty:**
  ```bash
  cd packages/twenty-mcp
  TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 \
    npx dotenv -e .env.local -- npx jest --testPathPattern='round-trip.test.ts' --config jest.config.ts
  ```
  Add a round-trip case: create a `DATE_TIME` field on a test object, attempt `CREATE_VIEW_FILTER` with `operand: 'GREATER_THAN_OR_EQUAL'`. Assert the proxy returns an error and that `metadata_query({kind: "view_filters"})` does NOT contain a filter row for that field. Expected: no bad row in Twenty's database.

## Failure modes named (R3: adversarial pre-mortem)

1. **The `get_field_metadata` lookup adds latency and a new failure mode**: Each `CREATE_VIEW_FILTER` / `UPDATE_VIEW_FILTER` dispatch now requires an extra round-trip to Twenty to look up the field type. If Twenty is unavailable or slow, this lookup can fail. If it fails, the wrapper falls back to fail-open (dispatches without validation). An attacker or a misbehaving Twenty instance could respond with a malformed type or a type not in the matrix to force fail-open and allow invalid operands through. Mitigation: (a) the fail-open path is explicitly documented and logged; (b) the round-trip is only added for view-filter ops; (c) if latency is a concern, the field-type lookup result can be memoised per `fieldMetadataId` within a single `apply_plan` call.

2. **The FIELD_TYPE_OPERAND_MAP becomes stale when Twenty adds new field types or operands**: The matrix is a static snapshot. If Twenty adds a new `DATE_RANGE` field type or a `WITHIN` operand, the wrapper will fail-open for that type (new type not in map) or block the new operand on old types (new operand not in any allowed list). Mitigation: the operand-matrix-coverage test (test plan item 5) enforces that every `ViewFilterOperand` enum member appears in at least one entry; when Twenty adds a new operand, the enum update will break that test, forcing an explicit matrix update. This is the same class of safeguard as the coverage test for mutation names.

3. **`UPDATE_VIEW_FILTER` does not have `fieldMetadataId` as a required field**: The `metadataUpdateViewFilterInputSchema` (`views.ts:171-185`) makes `fieldMetadataId` optional. When it is omitted (updating only `operand` or `value`), the wrapper cannot look up the field type and cannot validate the operand. Mitigation: for `UPDATE_VIEW_FILTER` with no `fieldMetadataId`, look up the existing filter row's `fieldMetadataId` from `metadata_query({kind: "view_filters", args: {id: ...}})` before validating. If that lookup also fails (filter not found), fail closed with an explicit error rather than fail open. This is a tighter approach than for `CREATE_VIEW_FILTER` because updating an existing filter that has already passed validation once is lower risk than creating a new one.

## Out of scope

- **Dry-run / pre-validation for the entire `apply_plan` before any dispatch**: The issue mentions this as a secondary improvement. Validating all ops before touching the database would require all field-type lookups to happen upfront. Deferred because it requires a two-phase architecture change to `metadataApplyPlan`. Worst case if deferred: a plan that creates a field and then immediately filters by it (field doesn't exist yet at validation time) would incorrectly fail validation. Accepted because the per-op validation (Layer 2 above) already catches the most dangerous case (bad operand persisted to Twenty).
- **Enforcing `value` format compatibility with the operand + field type**: The issue only names the operand/field-type matrix. Validating `value` (e.g., `IS_RELATIVE` requires a specific relative-date format string) is a further layer of defence. Deferred. Worst case if deferred: an invalid `value` format reaches Twenty's inner tool, which may reject it with a confusing error OR silently store it and break the frontend in a different way (same bug class: Imagined-because-plausible — "the value looks right so I shipped it"). Flagged for explicit review in a follow-up.
- **Applying the matrix to direct (non-apply_plan) calls to `metadata_create_view_filter`**: Layer 1 of the fix covers the direct handler. If the implementer chooses to only add the validation at the `apply_plan` layer (Layer 2), the direct `metadata_create_view_filter` tool remains unguarded. Both layers MUST be implemented; this is not an acceptable split.

## References

- packages/twenty-mcp/CLAUDE.md (R1–R5, L3: don't invent fields; L6: tool descriptions ARE the contract)
- packages/twenty-mcp/src/tools/views.ts:53-70 (ViewFilterOperand enum)
- packages/twenty-mcp/src/tools/views.ts:150-169 (metadataCreateViewFilterInputSchema — no cross-field validation)
- packages/twenty-mcp/src/tools/views.ts:171-185 (metadataUpdateViewFilterInputSchema)
- packages/twenty-mcp/src/tools/views.ts:219-223 (metadataCreateViewFilter handler — passes args verbatim to inner tool)
- packages/twenty-mcp/src/tools/views.ts:277-283 (metadata_create_view_filter tool description — matrix documented as prose only)
- packages/twenty-mcp/src/tools/metadata.ts:252-256 (APPLY_PLAN_DISPATCH — CREATE_VIEW_FILTER entry)
- packages/twenty-mcp/src/tools/metadata.ts:444-478 (metadataApplyPlan loop — no pre-dispatch semantic validation)
- packages/twenty-mcp/src/__tests__/views.test.ts (extend with operand validation tests)
- packages/twenty-mcp/src/__tests__/metadata.test.ts:416-437 (existing view op dispatch tests — do not break)
