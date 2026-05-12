# Plan: Stale hand-authored get_object_metadata fixture entry (L1 violation)

> Issue(s): #15
> Package: packages/twenty-mcp
> Severity: high
> Worst-case bug class if deferred: Tested-because-mock-passes — a contract test or schema-drift gate that relies on the hand-authored `get_object_metadata` fixture entry will silently mis-validate against a schema that does not match the deployed server (L1 from packages/twenty-mcp/CLAUDE.md)
> Created: 2026-05-12

## Problem statement

The fix for issues #12/#13 added a hand-authored entry for `get_object_metadata` to `packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json` (line 9720–9732). The entry's `description` and `inputSchema` diverge from the deployed server's actual schema: the fixture claims the tool accepts only an empty-properties object (`{}` with `additionalProperties: false`), while the server schema accepts `{id?: uuid, limit?: integer(1–100, default 100)}`. Additionally, `'get_object_metadata'` is absent from `STATIC_INNER_TOOL_NAMES` in `packages/twenty-mcp/scripts/capture-inner-schemas.ts` (lines 48–77), so re-running the capture script does not refresh this entry. The hand-authored lie persists indefinitely and forms an incorrect baseline for any future contract or coverage test that inspects this tool.

## Reproduction

```bash
# 1. Observe the stale hand-authored schema in the fixture.
grep -A 15 '"get_object_metadata"' \
  packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json
# Expected result: inputSchema shows empty properties {} — no id, no limit.

# 2. Confirm capture script excludes get_object_metadata.
grep 'get_object_metadata' packages/twenty-mcp/scripts/capture-inner-schemas.ts
# Expected result: zero matches — the name is not in STATIC_INNER_TOOL_NAMES.

# 3. Against a running local Twenty stack, verify the real schema differs.
# (Requires a live local Twenty — not derivable without one.)
# Reproduction of the exact divergence requires a running stack;
# the static evidence above is sufficient to confirm the L1 violation.
```

## Root cause hypothesis

`packages/twenty-mcp/scripts/capture-inner-schemas.ts:48–77` defines `STATIC_INNER_TOOL_NAMES` — the list of inner tool names the capture script will request from Twenty's `learn_tools` endpoint. `'get_object_metadata'` is not in this list. When the #12/#13 fix needed `get_object_metadata` in the fixture (so `coverage.test.ts` could pass), the implementer hand-transcribed the entry rather than adding the tool name to the capture list and re-running the script. The fixture entry at `inner-tool-schemas.json:9720–9732` uses a stub `inputSchema` (`properties: {}, additionalProperties: false`) that does not match the server (which accepts `{id?, limit?}` per `object-metadata-tools.factory.ts`). Because the capture script omits `get_object_metadata`, subsequent `capture-inner-schemas.ts` runs silently leave the stale entry in place.

## Proposed fix

1. **`packages/twenty-mcp/scripts/capture-inner-schemas.ts:48–77`** — add `'get_object_metadata'` to `STATIC_INNER_TOOL_NAMES`. Insert it alongside the other metadata read tools (e.g., after `'get_field_metadata'` on line 51):
   ```
   'get_field_metadata',
   'get_object_metadata',   // ← add this line
   ```

2. **Re-run the capture script against a local Twenty stack** to regenerate the fixture entry with the real schema:
   ```bash
   npx dotenv -e .env.local -- npx tsx scripts/capture-inner-schemas.ts
   ```
   The script's merge logic (lines 163–173) will update `inner-tool-schemas.json`'s `get_object_metadata` entry's `schema` field in place, preserving the existing `forbiddenTopLevel: []`.

3. **Verify** the regenerated entry's `description` and `inputSchema` match the deployed server's `get_object_metadata` schema (expected: `{id?: uuid, limit?: integer(1-100)}`).

4. **Commit** the regenerated fixture alongside the `capture-inner-schemas.ts` change.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] Confirm `'get_object_metadata'` appears in `STATIC_INNER_TOOL_NAMES` after the edit:
  ```bash
  grep 'get_object_metadata' packages/twenty-mcp/scripts/capture-inner-schemas.ts
  # Expected: at least one match inside the STATIC_INNER_TOOL_NAMES array literal
  ```
- [ ] Run the full unit suite to confirm no existing test is broken by the edit:
  ```bash
  cd packages/twenty-mcp && npx jest --testTimeout 10000
  # Expected: all tests pass (green)
  ```
- [ ] After running the capture script against a local stack, confirm the fixture entry no longer has an empty `properties: {}` inputSchema:
  ```bash
  python3 -c "
  import json, sys
  with open('packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json') as f:
      d = json.load(f)
  schema = d['tools']['get_object_metadata']['schema']['inputSchema']
  props = schema.get('properties', {})
  assert 'limit' in props or 'id' in props, f'Expected id/limit props; got: {list(props.keys())}'
  print('OK — fixture has real schema:', list(props.keys()))
  "
  # Expected: OK — fixture has real schema: ['id', 'limit'] (or equivalent)
  ```
- [ ] Run coverage test to confirm the updated fixture still passes the contract check:
  ```bash
  cd packages/twenty-mcp && npx jest src/__tests__/coverage.test.ts --testTimeout 10000
  # Expected: passes — coverage.test.ts's schema checks use the refreshed entry
  ```
- [ ] (Integration — requires local stack) Run the capture script and confirm it emits a `get_object_metadata` schema:
  ```bash
  npx dotenv -e .env.local -- npx tsx scripts/capture-inner-schemas.ts 2>&1 | grep 'get_object_metadata\|received'
  # Expected: "[capture] received N schemas" where N includes get_object_metadata
  ```

## Failure modes named (R3: adversarial pre-mortem)

1. **Script runs without a live stack, leaving the fixture stale**: implementer edits `STATIC_INNER_TOOL_NAMES` but forgets to re-run the capture script — the fixture still has the stub schema, and all tests pass because nothing asserts the fixture's `inputSchema` depth until a future schema-drift gate. Mitigation: the test plan item above explicitly asserts `id` or `limit` appear in the regenerated fixture; CI fails if the capture was skipped.

2. **Capture script returns zero schemas for `get_object_metadata`** (e.g., the tool was renamed in a newer Twenty release): the merge logic at `capture-inner-schemas.ts:166` creates a `{schema: null, forbiddenTopLevel: []}` stub instead of refreshing the entry, which is arguably worse than the hand-authored stub because `null` will throw at runtime when `coverage.test.ts` dereferences `schema.inputSchema`. Mitigation: the test plan item that asserts `list(props.keys())` will fail loudly in this scenario, surfacing the rename before commit.

3. **`forbiddenTopLevel` for `get_object_metadata` is inadvertently widened**: the capture script's merge logic preserves the existing `forbiddenTopLevel` array (line 169–172), so this risk is low — but if the implementer deletes and recreates the fixture entry from scratch rather than re-running the capture script, the curated `forbiddenTopLevel: []` may be wiped. Mitigation: the fix explicitly uses the capture script (not a manual JSON edit), which the merge loop guarantees preserves `forbiddenTopLevel`.

## Out of scope

- Refreshing all other hand-authored fixture entries — this plan is scoped to the single `get_object_metadata` entry that is both demonstrably stale and excluded from the capture script. Other entries are captured by the existing `STATIC_INNER_TOOL_NAMES` list and are not known to be stale. Worst case if deferred: same L1 bug class for any future hand-transcribed entry. Acceptable because the fix here directly addresses the mechanism (missing from capture list) that would reproduce the class.
- Validating the server source (`object-metadata-tools.factory.ts`) against the deployed binary — the capture script is the authoritative source per L1; source-code comparison is a secondary check only.

## Implementation notes — blocked
> Attempted: 2026-05-12T00:00:00Z

### Step 1 completed
`'get_object_metadata'` was added to `STATIC_INNER_TOOL_NAMES` in `packages/twenty-mcp/scripts/capture-inner-schemas.ts` (after `'get_field_metadata'`). Test plan item 1 passes. The full unit suite (218/218) passes.

### Step 2 failed — pre-existing bug in `extractSchemas` blocks fixture update

The capture script ran successfully (`[capture] received 29 schemas`, `[capture] wrote …inner-tool-schemas.json`), but test plan item 3 **failed**:

```
AssertionError: Expected id/limit props; got: []
```

**Root cause**: The `extractSchemas` function in `capture-inner-schemas.ts` (lines 100–119) assumes `learn_tools` returns `{ tools: Record<string, unknown> }` (a dict keyed by tool name). However, the live Twenty server at `http://localhost:4440` returns `{ tools: [...], notFound: [...], message: "..." }` — where `tools` is an **array** of tool objects, not a dict.

When `extractSchemas` extracts `parsed.tools` (an array) and the merge loop calls `Object.entries(schemas)` on it, it gets numeric string keys (`"0"`, `"1"`, `"2"`, ...) instead of tool names. The merge loop then stores fixture entries under `"0"`, `"1"`, etc. — never touching the named entry `"get_object_metadata"`.

Evidence:
```
# Server response shape (confirmed via curl):
{"tools": [{"name": "get_object_metadata", "description": "...", "inputSchema": {...}}, ...], "notFound": [], "message": "..."}

# After capture, fixture has:
python3 -c "
import json
with open('packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json') as f:
    d = json.load(f)
numeric_keys = [k for k in d['tools'].keys() if k.isdigit()]
print('Numeric keys:', numeric_keys[:5])
# Output: Numeric keys: ['0', '1', '2', '3', '4']
"
```

The `get_object_metadata` entry in `tools` is left unchanged (still has the stale stub with `properties: {}`).

**What the plan needs to also fix**: `extractSchemas` must handle the array format by converting it to a dict keyed by `name`. The fix is:

```typescript
// After: const candidate = ... parsed.tools ... parsed;
// Add:
const asDict: Record<string, unknown> = {};
if (Array.isArray(candidate)) {
  for (const item of candidate as Array<{ name?: string }>) {
    if (item && item.name) asDict[item.name] = item;
  }
  return asDict;
}
return candidate as Record<string, unknown>;
```

This is a change to `capture-inner-schemas.ts` that the plan does not explicitly list. Per implementation policy, I am not making this change silently. The supervisor must add it to the plan's `## Proposed fix` section before I proceed.

**Note**: This `extractSchemas` array-format bug is pre-existing and affects ALL static tools, not just `get_object_metadata`. The other named static tool entries in the fixture (e.g., `get_field_metadata`) retain their correct data only because they were captured during a previous run when the format was different. Every current capture run silently writes new schemas under numeric keys and leaves existing named entries stale. This is a broader issue that the supervisor may wish to address.

## References

- packages/twenty-mcp/CLAUDE.md (L1: "Capture; don't transcribe." + R4 evaluation rule)
- packages/twenty-mcp/scripts/capture-inner-schemas.ts:48–77 (STATIC_INNER_TOOL_NAMES)
- packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json:9720–9732 (stale entry)
- packages/twenty-mcp/plans/issue-12-crm-wrapper-name-inference-replace-with-server-metadata.md (prior plan that introduced the stale entry)
- packages/twenty-mcp/plans/issue-12-crm-wrapper-name-inference-replace-with-server-metadata-audit-round-1.md (audit that flagged this as a follow-up)
