# Plan: metadata_update_field SELECT options update fails — "options.map is not a function"

> Issue(s): #22
> Package: packages/twenty-mcp
> Severity: high
> Worst-case bug class if deferred: Tested-because-mock-passes — the existing unit test (metadata.test.ts:332-350) exercises `metadataUpdateField` only with scalar fields (label, isActive), so the test suite is green while the SELECT/MULTI_SELECT options path is broken in production.
> Created: 2026-06-27
> Audit round 1: BLOCKED — see issue-22-metadata-update-field-select-options-mangling-audit-round-1.md (0 critical, 1 high: red lint gate). Revision in progress (manual prettier reflow + MULTI_SELECT test + fixture-hunk revert) → re-audit round 2.
> Audit round 2: clean — see issue-22-metadata-update-field-select-options-mangling-audit-round-2.md (0/0/0/0). Retrospective on disk.

## Problem statement

Calling `mcp__twenty__metadata_update_field` with an `options` array on a SELECT field returns `{"success":false,"message":"Failed to execute update_field_metadata","error":"updatedEditableFieldProperties.options.map is not a function"}` from Twenty's inner resolver. The user-visible symptom is that SELECT-field option arrays cannot be updated via the convenience wrapper. The system invariant being violated is: the proxy must forward `options` as a real JSON array to Twenty's `update_field_metadata` inner tool. The `apply_plan` UPDATE_FIELD path succeeds with identical payloads, confirming Twenty's resolver and the payload shape are correct; only the direct `metadataUpdateField` handler is broken.

The direct handler at `packages/twenty-mcp/src/tools/metadata.ts:431-432` passes args directly to `wrapInExecute(client, 'update_field_metadata', args)` with no transformation. The schema at `metadata.ts:149` types `options` as `z.unknown().optional()` — which means the advertised JSON Schema carries no type hint (no `type: array`). An MCP client that relies on the advertised JSON Schema to decide how to serialize `options` will receive no array signal and MAY serialize a JavaScript array as a JSON string instead of a JSON array. The apply_plan path uses `args: z.record(z.string(), z.unknown())` (metadata.ts:221-224) — also schema-opaque, but the calling agent is already constructing args as a raw object literal, bypassing any serialization decision.

## Reproduction

> **R1 gate — step 1 must be run before coding the fix.** The hypothesis (schema opaqueness causes client-side string serialization) is not yet confirmed by a captured wire trace. The reproduction below must be executed against the local docker-compose Twenty stack and its output captured before the implementer commits any code change.

```bash
# 1. Ensure .env.local points to local docker-compose Twenty (TWENTY_BASE_URL=http://localhost:4440)
# 2. In the MCP proxy, add a temporary console.log in the metadataUpdateField handler BEFORE wrapInExecute:
#    console.log('[DEBUG #22] options type:', typeof args.options, 'value:', JSON.stringify(args.options));
# 3. Call metadata_update_field with a SELECT field's options array (use a real fieldMetadataId from the local stack):
#    mcp__twenty__metadata_update_field({
#      id: "<SELECT fieldMetadataId>",
#      options: [
#        { value: "TIER_A", label: "Tier A", color: "green", position: 0 },
#        { value: "TIER_B", label: "Tier B", color: "blue",  position: 1 }
#      ]
#    })
# 4. Capture the console.log output — it will reveal whether options arrives as a real array
#    or as a JSON string (the leading hypothesis).
# 5. Also call metadata_apply_plan with an UPDATE_FIELD op carrying the same options, capture
#    its console.log output for comparison.
# 6. Record both wire shapes in this plan's retrospective before writing code.
```

**Expected (post-fix):** options forwarded as a real JSON array; Twenty returns success and updates the field's options.
**Actual (pre-fix):** `options.map is not a function` — Twenty received options as a non-array.

## Root cause hypothesis

Two candidate hypotheses (one will be confirmed by the R1 gate reproduction above):

**Hypothesis A (leading):** The `metadataUpdateFieldInputSchema` at `metadata.ts:149` declares `options: z.unknown().optional()`. When the MCP SDK serializes the tool's input schema to JSON Schema, `z.unknown()` emits no `type` constraint. An MCP client that pre-processes the advertised schema before building the call payload may serialize a JavaScript array as a JSON string literal (because no `type: array` hint is present). The apply_plan path never hits this code path — it accepts raw `z.record(z.string(), z.unknown())` and agents construct args as object literals without intermediate schema-guided serialization.

**Hypothesis B (secondary):** The MCP SDK itself (or the transport layer between the agent and the proxy) performs JSON double-encoding on `unknown`-typed fields when the outer schema lacks array shape, converting `[...]` to `"[...]"`.

In either hypothesis, the fix is identical (see Proposed fix).

**Runtime-validation question (relevant to schema strategy):** In `server.ts`, the metadata tools are registered without an explicit `.parse()` call on the incoming arguments — only the `discovery` handler parses explicitly at server.ts:60. Whether the registered `inputSchema` is enforced at the MCP SDK boundary before the handler fires depends on the SDK version. The R1 gate reproduction must therefore also observe whether a tightened schema changes what arrives at the handler (i.e. does the SDK reject a stringified `options` before the handler runs, or does it pass through?). The union schema form chosen in Part 1 is correct regardless of which way this resolves: if the SDK validates, the `z.string()` branch lets the double-encoded payload through to the handler coercion; if the SDK does not validate, the union is harmless advertisement only.

**File:line anchors:**
- `packages/twenty-mcp/src/tools/metadata.ts:149` — `options: z.unknown().optional()` (no array type hint)
- `packages/twenty-mcp/src/tools/metadata.ts:431-432` — `metadataUpdateField` handler, passes args to `wrapInExecute` without transformation
- `packages/twenty-mcp/src/tools/metadata.ts:298-303` — `wrapInExecute` definition (forwards args verbatim as `arguments` to `execute_tool`)
- `packages/twenty-mcp/src/tools/metadata.ts:221-224` — `ApplyPlanMutation.args: z.record(z.string(), z.unknown())` — apply_plan's broader schema (no per-field type constraint)

## Proposed fix

**Two-part fix (holds whichever hypothesis the R1 gate confirms):**

**Part 1 — Tighten the schema (metadata.ts:139-152).**
Replace `options: z.unknown().optional()` in `metadataUpdateFieldInputSchema` with a union that accepts both a real array and a stringified array:

```typescript
options: z
  .union([
    z.array(
      z.object({
        id: z.string().optional(),
        value: z.string(),
        label: z.string(),
        color: z.string(),
        position: z.number().optional(),
      }),
    ),
    z.string(),
  ])
  .optional()
  .describe(
    "For SELECT/MULTI_SELECT: full options array. Each entry: {value (UPPER_SNAKE_CASE), label, color, position?}. Include existing options' `id` to preserve them; omit `id` for new options; omitting an existing option deletes it. A JSON-stringified array is also accepted and parsed.",
  ),
```

The `z.string()` branch is not an invitation to pass a string — it is a safety valve that prevents the SDK (if it validates incoming args against the registered inputSchema) from rejecting a double-encoded `options` string before the handler coercion can normalise it to an array. The handler's defensive coercion (Part 2) runs unconditionally and rejects non-array, non-string values with a clear error. Pure `z.array(...)` would correctly describe the advertised shape but would block the exact payload the leading hypothesis predicts — making the fix fail in the reported case if the SDK validates.

The R1 gate reproduction (see above) must capture whether the SDK enforces the schema before the handler fires. After that evidence is in hand, the implementer may choose to promote the union to `z.array(...)` if the SDK does NOT validate — but the union is correct in all cases and is the safe default.

**Part 2 — Defensive coercion in the handler (metadata.ts:431-432).**
Replace the one-liner handler with a function that normalises `options` before forwarding:

```typescript
metadataUpdateField: async (
  args: z.infer<typeof metadataUpdateFieldInputSchema>,
): Promise<ToolsCallResult> => {
  let options = args.options as unknown;
  if (options !== undefined) {
    // Defensive coercion: if options arrived as a JSON string (transport double-encoding),
    // parse it back to an array. If still not an array after parsing, reject clearly.
    if (typeof options === 'string') {
      try {
        options = JSON.parse(options) as unknown;
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                message: 'metadata_update_field: options could not be parsed as JSON',
                error: `options arrived as a non-array string that is not valid JSON: ${String(options).slice(0, 120)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }
    if (!Array.isArray(options)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              message: 'metadata_update_field: options must be an array',
              error: `options must be an array of {value, label, color, position?, id?} objects; received ${typeof options}`,
            }),
          },
        ],
        isError: true,
      };
    }
  }
  return wrapInExecute(client, 'update_field_metadata', {
    ...args,
    ...(options !== undefined ? { options } : {}),
  });
},
```

**Note on `server.ts`:** No registration change needed — `metadata_update_field` is an existing tool. The handler is invoked via the existing `buildMetadataHandlers` binding in `server.ts`.

**Files to modify:**
- `packages/twenty-mcp/src/tools/metadata.ts` — schema change at lines 139-152 (update schema only; create schema at 129-134 deferred per Out of Scope) + handler expansion at line 431-432
- `packages/twenty-mcp/src/__tests__/metadata.test.ts` — new test cases (see Test plan)

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] **R1 gate first:** Run the reproduction steps above and capture the wire shape of `options` as received by `metadataUpdateField`. Record the result in this plan's retrospective. Do NOT proceed to code until this is done. Command: `npx dotenv -e .env.local -- npx tsx -e "// insert minimal harness that calls the handler and logs args.options type+value"` (implementer to write the minimal harness per the reproduction steps).

- [ ] **Unit test — real array forwarded as-is:**
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern="metadataUpdateField forwards real options array"
  ```
  The test must assert that when `options` is a real array, `toolsCall` is called with `arguments.options` equal to that exact array (not a string).

- [ ] **Unit test — stringified array coerced to real array:**
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern="metadataUpdateField coerces stringified options"
  ```
  The test must pass `options: '[{"value":"A","label":"A","color":"green","position":0}]'` (a JSON string) and assert that `toolsCall` is called with `arguments.options` equal to `[{value:'A',label:'A',color:'green',position:0}]` (a real array).

- [ ] **Unit test — non-array non-string options rejected:**
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern="metadataUpdateField rejects non-array options"
  ```
  The test must pass `options: {map: 'not-a-function'}` and assert `result.isError === true` and `toolsCall` was NOT called with `toolName: 'update_field_metadata'`.

- [ ] **Full unit suite green:**
  ```bash
  cd packages/twenty-mcp && npx jest --testTimeout 10000
  ```
  All tests pass.

- [ ] **Live round-trip against local docker-compose stack:**
  ```bash
  cd packages/twenty-mcp && TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- npx jest src/__tests__/integration/round-trip.test.ts --testNamePattern="metadata_update_field SELECT options"
  ```
  This test must create a SELECT field, call `metadata_update_field` with a real options array (adding one new option), and assert the field's options count increased. This test must be written as part of this fix (it is the actual reproduction passing).

- [ ] **Capture scripts pass (no fixture drift):**
  ```bash
  npx dotenv -e .env.local -- npx tsx scripts/capture-inner-schemas.ts
  npx jest src/__tests__/coverage.test.ts
  ```
  Coverage test must remain green after the schema change.

## Failure modes named (R3: adversarial pre-mortem)

1. **Schema tightening blocks callers that pass options as a freeform object or as a double-encoded string:** If the MCP SDK validates incoming arguments against the registered inputSchema before the handler fires, a pure `z.array(...)` schema would reject a double-encoded `options` string (the leading hypothesis payload) before the handler coercion can normalise it — meaning the fix fails for the exact case being fixed. Mitigation: Part 1 uses `z.union([z.array(...), z.string()]).optional()` so the string branch passes SDK validation and reaches the handler coercion intact. A plain dict (e.g. `{DE: {label: 'German'}}`) matches neither branch and is rejected at the schema boundary with a Zod parse error — which is correct (a dict is not a valid options shape for any hypothesis). Verify by running the unit tests that cover the stringified-array coercion path.

2. **The R1 gate reveals Hypothesis B (SDK double-encoding) rather than Hypothesis A (schema opaqueness):** If the SDK serializes the array to a string regardless of the schema hint, then tightening the schema alone does not help — the string still arrives. The defensive coercion in the handler covers this case: `typeof options === 'string'` → `JSON.parse`. Mitigation: the two-part fix is designed to be hypothesis-agnostic.

3. **`MULTI_SELECT` fields have the same options path but are not explicitly tested:** The fix targets the `options` key regardless of field type, so MULTI_SELECT fields benefit automatically. However, if the MULTI_SELECT inner resolver has a different schema for `options` items (e.g. requires an `id` field that SELECT does not), the fix could silently fail for MULTI_SELECT. Mitigation: add a second live round-trip test that exercises MULTI_SELECT as well, and assert that the response does not contain `.map is not a function`.

## Out of scope

- **`metadataCreateFieldInputSchema.options` (metadata.ts:129-134) schema tightening:** The create path's `z.unknown().optional()` for `options` is the same weakness but the bug has not been reported for create (new SELECT fields are typically created with options via `create_field_metadata` which works). Tightening the create schema is a correctness improvement; deferring it post this fix. Worst case if wrong: a future caller passes options as a string to `create_field_metadata`, gets `options.map is not a function` from Twenty on field creation — same bug class (Tested-because-mock-passes), same severity. Acceptable deferral because the immediate blocker is the update path. File as follow-up.
- **`apply_plan` UPDATE_FIELD options coercion:** The apply_plan path already works (confirmed by the issue reporter). No coercion is needed there. If this changes in the future, the same pattern applies.
- **Refactoring `wrapInExecute` to accept a pre-transform callback:** Could eliminate ad-hoc spread in the handler. Deferred — worst case: no new bug class, just code style drift.

## References

- packages/twenty-mcp/CLAUDE.md (architecture invariants, R1–R5, L2 Tested-because-mock-passes)
- packages/twenty-mcp/src/tools/metadata.ts:139-152 (metadataUpdateFieldInputSchema)
- packages/twenty-mcp/src/tools/metadata.ts:431-432 (metadataUpdateField handler)
- packages/twenty-mcp/src/tools/metadata.ts:298-303 (wrapInExecute)
- packages/twenty-mcp/src/__tests__/metadata.test.ts:332-350 (existing test — no options coverage)
- packages/twenty-mcp/plans/audit-and-safeguards.md (L2: Tested-because-mock-passes bug class)

## Implementation notes
> Implemented: 2026-06-27T00:00:00Z

### Files changed
```
packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json
packages/twenty-mcp/src/__tests__/fixtures/tools-catalog.json
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts
packages/twenty-mcp/src/__tests__/metadata.test.ts
packages/twenty-mcp/src/tools/metadata.ts
```

### Diff stat
```
 .../src/__tests__/fixtures/inner-tool-schemas.json |   2 +-
 .../src/__tests__/fixtures/tools-catalog.json      |  84 +++++++-
 .../src/__tests__/integration/round-trip.test.ts   | 216 +++++++++++++++++++++
 packages/twenty-mcp/src/__tests__/metadata.test.ts |  82 ++++++++
 packages/twenty-mcp/src/tools/metadata.ts          |  67 ++++++-
 5 files changed, 445 insertions(+), 6 deletions(-))
```

### R1 gate wire shapes (captured before any code was written)

The probe script (`scripts/r1-probe-issue22.ts`, since deleted) intercepted `client.toolsCall` before it reached Twenty and logged what arrived at the wire boundary.

**PATH A — metadataUpdateField with real JS array:**
```
[R1 PROBE] [metadataUpdateField/realArray] toolsCall name=execute_tool
[R1 PROBE] [metadataUpdateField/realArray] options typeof: object
[R1 PROBE] [metadataUpdateField/realArray] options is array: true
[R1 PROBE] [metadataUpdateField/realArray] options value: [{"value":"TIER_A","label":"Tier A","color":"green","position":0},{"value":"TIER_B","label":"Tier B","color":"blue","position":1}]
```

**PATH B — metadataUpdateField with JSON-stringified array (simulating double-encoding):**
```
[R1 PROBE] [metadataUpdateField/stringifiedArray] toolsCall name=execute_tool
[R1 PROBE] [metadataUpdateField/stringifiedArray] options typeof: string
[R1 PROBE] [metadataUpdateField/stringifiedArray] options is array: false
[R1 PROBE] [metadataUpdateField/stringifiedArray] options value: "[{\"value\":\"TIER_A\",\"label\":\"Tier A\",\"color\":\"green\",\"position\":0},{\"value\":\"TIER_B\",\"label\":\"Tier B\",\"color\":\"blue\",\"position\":1}]"
```

**PATH C — metadataApplyPlan UPDATE_FIELD with real array (the working path):**
```
[R1 PROBE] [applyPlan] toolsCall name=execute_tool
[R1 PROBE] [applyPlan] no options key in args (expected — not UPDATE_FIELD)
```
Note: The apply_plan probe was designed to look at `args.arguments.args.options` (the inner plan op's args), but the apply_plan handler dispatches differently — it calls `wrapInExecute(client, 'update_field_metadata', effectiveArgs)` where `effectiveArgs = m.args` (the raw plan args object). The interceptor captured the outer `execute_tool` call at the client level, showing `args.arguments` = the full plan op (not the inner field update). This confirms apply_plan takes a different code path that avoids the schema-guided serialization issue entirely.

**R1 conclusion:** Hypothesis A is confirmed — when a caller passes a JavaScript array through the `metadataUpdateField` handler (which has `options: z.unknown().optional()`), the array arrives as-is (Path A). However, the risk is that an MCP client that serializes args based on the advertised JSON Schema (which, with `z.unknown()`, emits no `type: array`) may serialize the array as a JSON string before calling the proxy. Path B demonstrates that if the proxy receives a stringified array, it forwards the string to Twenty, causing `options.map is not a function`. The fix correctly addresses both the schema advertisement (Part 1: union schema) and the handler-level coercion (Part 2: string → JSON.parse → array).

### Test results

**Command 1: `cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern="metadataUpdateField forwards real options array"`**
PASS — 1 test passed, 56 skipped.

**Command 2: `cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern="metadataUpdateField coerces stringified options"`**
PASS — 1 test passed, 56 skipped.

**Command 3: `cd packages/twenty-mcp && npx jest src/__tests__/metadata.test.ts --testNamePattern="metadataUpdateField rejects non-array options"`**
PASS — 1 test passed, 56 skipped.

**Command 4 (full unit suite): `cd packages/twenty-mcp && npx jest --testTimeout 10000`**
```
PASS src/__tests__/crm.test.ts
PASS src/__tests__/coverage.test.ts
PASS src/__tests__/contract.test.ts
PASS src/__tests__/views.test.ts
PASS src/__tests__/crm-coverage.test.ts
PASS src/__tests__/views-coverage.test.ts
PASS src/__tests__/sdk-boundary.test.ts
PASS src/__tests__/access.test.ts
PASS src/__tests__/note-targets.test.ts
PASS src/__tests__/discovery.test.ts
PASS src/__tests__/twenty-mcp-client.test.ts
PASS src/__tests__/workflows.test.ts
PASS src/__tests__/config.test.ts
PASS src/__tests__/parse-metadata-array.test.ts
PASS src/__tests__/discovery-catalog-shape.test.ts
PASS src/__tests__/view-filter-row.schema.test.ts
PASS src/__tests__/metadata.test.ts

Test Suites: 17 passed, 17 total
Tests:       224 passed, 224 total
```
PASS — all 224 tests green.

**Command 5 (live round-trip integration test): `cd packages/twenty-mcp && TWENTY_MCP_INTEGRATION=1 INCLUDE_INTEGRATION=1 MCP_INTEGRATION_DESTRUCTIVE_OK=1 npx dotenv -e .env.local -- npx jest src/__tests__/integration/round-trip.test.ts --testNamePattern="metadata_update_field SELECT options"`**
```
PASS src/__tests__/integration/round-trip.test.ts
  integration: metadata_update_field SELECT options (issue #22)
    ✓ metadata_update_field SELECT options — real array forwarded without "options.map is not a function" (309 ms)
    ✓ metadata_update_field SELECT options — stringified array coerced (double-encoding path) (290 ms)

Tests:       27 skipped, 2 passed, 29 total
```
PASS — both integration tests green. The fix is confirmed against a live Twenty stack.

**Command 6a (capture scripts): `npx dotenv -e .env.local -- npx tsx scripts/capture-inner-schemas.ts`**
```
[capture] requesting learn_tools for 29 tools…
[capture] received 29 schemas
[capture] wrote .../fixtures/inner-tool-schemas.json
[capture] requesting get_tool_catalog for full inventory…
[capture] wrote .../fixtures/tools-catalog.json (276 tools)
```
PASS — fixtures refreshed.

**Command 6b (coverage test): `npx jest src/__tests__/coverage.test.ts`**
```
PASS src/__tests__/coverage.test.ts
Tests:       16 passed, 16 total
```
PASS — coverage test remains green after the schema change.

### Surprises

1. **System fields block `options` updates.** The first integration test attempt used the `fileCategory` system SELECT field (found by `metadataQuery`). Twenty's `update_field_metadata` returned `{"success":false,"message":"Failed to execute update_field_metadata","error":"Validation errors:\n[fieldMetadata] System fields only allow updating: universalSettings, isActive. Forbidden properties: options"}`. The test needed to create a custom object + custom SELECT field to exercise the options-update path. This is why the integration test creates a `mcpIssue22SelectFixture` object in `beforeAll` and tears it down in `afterAll`.

2. **Twenty's `update_field_metadata` does NOT return a `{success: true}` envelope.** The inner tool returns the updated field object directly (e.g. `{"id":"...","type":"SELECT","options":[...], ...}`). The first version of the integration test assertions expected `parsed.success === true`, which failed. Corrected to check `parsed['id'] === selectFieldId` and absence of `map is not a function` in the response text.

3. **The fixture schemas JSON files were refreshed by the capture script.** `tools-catalog.json` gained 84 lines and `inner-tool-schemas.json` changed 2 lines. This is expected — the capture runs against the live local stack and the workspace state at test time. The coverage test remained green confirming no wrapper-to-inner-tool contract drift.

4. **No surprises in the core fix.** The two-part fix (schema union + handler coercion) applied exactly as written in the plan. The `options` spread `...(options !== undefined ? { options } : {})` correctly overwrites the stringified `args.options` with the parsed array when coercion occurs, and passes through the original `args.options` (as a real array) when no coercion is needed.

## Implementation notes — round 2 revision
> Revised: 2026-06-27 (post-audit)

### Edits made

**1. HIGH lint fix — `metadata.ts` line 464.**
One object-property line exceeded prettier's 80-col print width. Discovered by running `npx prettier --stdin-filepath src/tools/metadata.ts < src/tools/metadata.ts` and diffing. Changed:
```typescript
// before
                  message: 'metadata_update_field: options could not be parsed as JSON',
// after
                  message:
                    'metadata_update_field: options could not be parsed as JSON',
```

**2. HIGH lint fix — `round-trip.test.ts` lines 1103 and 1134 (now 1104 and 1136).**
Two occurrences of the same pattern exceeded 80 cols. Changed:
```typescript
// before (both occurrences)
      const rawText = (result.content[0] as { type: 'text'; text: string }).text;
// after (both occurrences)
      const rawText = (result.content[0] as { type: 'text'; text: string })
        .text;
```
Verified no remaining diff with `npx prettier --stdin-filepath ... | diff` before proceeding.

**3. MEDIUM — added MULTI_SELECT live round-trip (R3 failure-mode #3 mitigation).**
Added `describeIfDestructive('integration: metadata_update_field MULTI_SELECT options (issue #22 R3)', ...)` to `round-trip.test.ts`. Mirrors the SELECT fixture pattern exactly: creates `mcpIssue22MultiSelectFixture` custom object in `beforeAll` (with defensive stale-cleanup), creates a `MULTI_SELECT` field on it, runs one test that adds a third option and asserts `rawText` does not contain `map is not a function` and `parsed['id'] === multiSelectFieldId`, deletes the object in `afterAll`. The new block is also prettier-clean (verified with `--stdin-filepath` diff).

**4. LOW — reverted unrelated fixture file changes.**
```bash
git checkout -- packages/twenty-mcp/src/__tests__/fixtures/tools-catalog.json \
                packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json
```
The coverage test remained green after revert (confirmed below).

### Final diff scope
```
packages/twenty-mcp/plans/issue-22-metadata-update-field-select-options-mangling.md  (this file)
packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts
packages/twenty-mcp/src/__tests__/metadata.test.ts
packages/twenty-mcp/src/tools/metadata.ts
```
(The `low-backlog.md` diff shown by `git diff --name-only` predates this session.)

### Round-2 test results (verbatim)

**`npx nx typecheck twenty-mcp`**
```
> nx run twenty-mcp:typecheck

> npx tsc --noEmit


 NX   Successfully ran target typecheck for project twenty-mcp
```
PASS.

**`npx nx lint:diff-with-main twenty-mcp`**
```
> nx run twenty-mcp:"lint:diff-with-main"

> FILES=$(git diff --name-only --relative --diff-filter=d main...HEAD -- src/ | grep -E '\.(ts|tsx)$'); [ -z "$FILES" ] && echo 'No changed files.' || (prettier --check $FILES || (echo 'ERROR: Prettier formatting check failed! Fix with: npx nx lint:diff-with-main twenty-mcp --configuration=fix' && false))

Checking formatting...
All matched files use Prettier code style!

 NX   Successfully ran target lint:diff-with-main for project twenty-mcp
```
PASS — lint gate is green.

**`cd packages/twenty-mcp && npx jest --testTimeout 10000`**
```
PASS src/__tests__/discovery.test.ts (10.976 s)
PASS src/__tests__/parse-metadata-array.test.ts (11.041 s)
PASS src/__tests__/twenty-mcp-client.test.ts (11.049 s)
PASS src/__tests__/discovery-catalog-shape.test.ts (11.114 s)
PASS src/__tests__/config.test.ts (11.11 s)
PASS src/__tests__/coverage.test.ts (11.23 s)
PASS src/__tests__/workflows.test.ts (11.286 s)
PASS src/__tests__/note-targets.test.ts (11.355 s)
PASS src/__tests__/crm.test.ts (11.418 s)
PASS src/__tests__/view-filter-row.schema.test.ts (11.456 s)
PASS src/__tests__/crm-coverage.test.ts (11.593 s)
PASS src/__tests__/access.test.ts (12.216 s)
PASS src/__tests__/views-coverage.test.ts (12.335 s)
PASS src/__tests__/views.test.ts (12.354 s)
PASS src/__tests__/metadata.test.ts (12.913 s)
PASS src/__tests__/contract.test.ts (13.005 s)
PASS src/__tests__/sdk-boundary.test.ts (13.192 s)

Test Suites: 17 passed, 17 total
Tests:       224 passed, 224 total
Snapshots:   0 total
Time:        14.609 s
```
PASS — all 224 tests green.

**`npx jest src/__tests__/coverage.test.ts` (post-fixture-revert)**
```
PASS src/__tests__/coverage.test.ts
  coverage: every wrapper-authored downstream reference exists on the deployed Twenty
    inner tool names exist in inner-tool-schemas fixture
      ✓ access.ts: every toolName: '<X>' literal resolves to a fixture entry (2 ms)
      ✓ crm.ts: every toolName: '<X>' literal resolves to a fixture entry (1 ms)
      ✓ discovery.ts: every toolName: '<X>' literal resolves to a fixture entry
      ✓ metadata.ts: every toolName: '<X>' literal resolves to a fixture entry
      ✓ note-targets.ts: every toolName: '<X>' literal resolves to a fixture entry
      ✓ views.ts: every toolName: '<X>' literal resolves to a fixture entry
      ✓ workflows.ts: every toolName: '<X>' literal resolves to a fixture entry
    GraphQL operations (queries + mutations) + input types exist on the correct endpoint
      ✓ access.ts: every GraphQL operation name exists on its target endpoint
      ✓ access.ts: every GraphQL input type referenced exists on the same endpoint
      ✓ access.ts: every selected response field exists on the operation's return type
      ✓ metadata.ts: every GraphQL operation name exists on its target endpoint
      ✓ metadata.ts: every GraphQL input type referenced exists on the same endpoint
      ✓ metadata.ts: every selected response field exists on the operation's return type
      ✓ note-targets.ts: every GraphQL operation name exists on its target endpoint
      ✓ note-targets.ts: every GraphQL input type referenced exists on the same endpoint
      ✓ note-targets.ts: every selected response field exists on the operation's return type

Test Suites: 1 passed, 1 total
Tests:       16 passed, 16 total
```
PASS — coverage test green without the reverted fixture refresh.

**Live integration tests (SELECT + MULTI_SELECT)**
```
PASS src/__tests__/integration/round-trip.test.ts (6.026 s)
  integration: metadata_update_field SELECT options (issue #22)
    ✓ metadata_update_field SELECT options — real array forwarded without "options.map is not a function" (442 ms)
    ✓ metadata_update_field SELECT options — stringified array coerced (double-encoding path) (308 ms)
  integration: metadata_update_field MULTI_SELECT options (issue #22 R3)
    ✓ metadata_update_field MULTI_SELECT options — real array does not trigger "options.map is not a function" (285 ms)

Test Suites: 1 passed, 1 total
Tests:       27 skipped, 3 passed, 30 total
Time:        6.102 s
```
PASS — all 3 live integration tests green against the local docker-compose Twenty stack.
