# Plan: No test exercises the MCP SDK tools/list boundary for metadata tools

> Issue(s): #6
> Package: packages/twenty-mcp
> Severity: low
> Worst-case bug class if deferred: Done-because-foreground-checklist-empty — a tool is defined in a `*ToolDefinitions` map and absent from `server.registerTool(...)` (or vice versa) with no CI signal catching the mismatch. This is the exact surprise that motivated the lesson "plan's 'Files to modify' list MUST include src/server.ts" in CLAUDE.md.
> Created: 2026-05-02

## Problem statement

`packages/twenty-mcp/src/server.ts` registers every wrapper tool via `server.registerTool(...)`. No test exercises this SDK boundary: existing coverage (`coverage.test.ts`) extracts tool-name literals from source files, `contract.test.ts` validates forwarded arg shapes against inner-tool fixture schemas, and per-tool unit tests call handlers directly — none of them boot the MCP SDK and call `tools/list`. A tool can therefore be present in a `*ToolDefinitions` map but absent from `server.registerTool(...)` (defined-but-not-registered), or registered under a different name than the definition key (name-drift), and no test will catch it. The gap applies uniformly across all tool families: `crmToolDefinitions`, `metadataToolDefinitions`, `viewToolDefinitions`, `accessToolDefinitions`, `workflowToolDefinitions`, and `noteTargetToolDefinitions`.

## Reproduction

No live stack needed. The gap is demonstrable by inspection:

1. Add a new key to `viewToolDefinitions` in `packages/twenty-mcp/src/tools/views.ts` without adding a corresponding `server.registerTool(...)` call in `packages/twenty-mcp/src/server.ts`.
2. Run `npx jest --config packages/twenty-mcp/jest.config.ts` — all tests pass. The missing registration is undetected.

## Root cause hypothesis

`packages/twenty-mcp/src/server.ts` — the `registerTool` calls exist and are correct today, but they are not contractually linked to the `*ToolDefinitions` maps. The maps are imported in `server.ts` for their definition shapes (title, description, inputSchema, annotations), but nothing asserts that every key in a map has a `registerTool` call and vice versa.

The only mechanical check currently in place is `coverage.test.ts`, which asserts that inner-tool name literals exist in the captured fixture — it says nothing about the MCP SDK's tool registry. The before-shipping checklist's CLAUDE.md note ("plan's Files to modify list MUST include src/server.ts") is documentation, not a verifier.

Concretely: `packages/twenty-mcp/src/server.ts:95-341` is a long `if (enableMetadata)` block with 37 `registerTool` calls. A future implementer adding a new tool could plausibly add the definition entry and the handler but forget the `registerTool` call — as happened in earlier issues. The gap is the absence of an assertion that the SDK's `tools/list` response equals the union of all definition maps.

## Proposed fix

Add a new test file `packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts` that:

1. Imports `createServer` from `packages/twenty-mcp/src/server.ts`.
2. Imports all six definition maps (`crmToolDefinitions`, `metadataToolDefinitions`, `viewToolDefinitions`, `accessToolDefinitions`, `workflowToolDefinitions`, `noteTargetToolDefinitions`) plus `discoveryToolDefinition`.
3. Calls `createServer({ twentyBaseUrl: 'http://localhost:4440', twentyApiKey: 'test', enableMetadata: true })` — no network calls are made because no client method is invoked at registration time.
4. Calls the MCP SDK's `server.listTools()` method (or the in-process equivalent — see note below) to obtain the list of registered tool names.
5. Asserts that every key in the union of all definition maps appears in the registered list.
6. Asserts that every name in the registered list has a corresponding definition key (no stray registrations).

Note on `listTools()`: the `@modelcontextprotocol/sdk` `McpServer` class exposes `server.listTools()` synchronously as of the version in use (the capability map is built during `registerTool` calls). If the SDK version does not expose `listTools()` directly, use `(server as any)._registeredTools` or the equivalent internal map — document the SDK version assumption and pin it in the test. Alternatively, create an in-memory transport connection and call `tools/list` via the protocol message: `const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); const { tools } = await client.listTools();`.

No changes to `server.ts` itself — the test is purely additive.

The `discoveryToolDefinition` is a single object (not a map); handle it separately as a constant `{ discovery: discoveryToolDefinition }`.

## Test plan (R4: every assertion has a mechanical verifier)

- [ ] `cd packages/twenty-mcp && npx jest src/__tests__/sdk-boundary.test.ts --config jest.config.ts` — expect: 2 tests pass ("all definition keys are registered" + "no stray registrations"). This is the primary mechanical verifier.
- [ ] Regression: temporarily remove one `server.registerTool(...)` call from `server.ts` (e.g., `metadata_compute_plan_hash`) and rerun the test — expect: test fails with `"metadata_compute_plan_hash" defined in metadataToolDefinitions but not registered`. Restore before committing.
- [ ] Regression: temporarily add an extra key to `viewToolDefinitions` without adding a `registerTool` call — expect: test fails with `"metadata_test_tool" defined in viewToolDefinitions but not registered`. Restore before committing.
- [ ] `cd packages/twenty-mcp && npx jest --config jest.config.ts` — full unit suite must remain green (no regressions). Expect 14+ suites, all passing.
- [ ] `cd packages/twenty-mcp && npx nx typecheck twenty-mcp` — expect: 0 TypeScript errors.

## Failure modes named (R3: adversarial pre-mortem)

1. **SDK version drift changes the `listTools()` API.** If `@modelcontextprotocol/sdk` renames or removes the `listTools()` method between versions, the test will fail with a runtime error rather than a useful assertion failure. Mitigation: use the in-memory transport + protocol-message approach (`InMemoryTransport.createLinkedPair()`) which is part of the stable `tools/list` protocol message, not an internal SDK method. Document the SDK version in the test comment.

2. **`enableMetadata: false` path is not tested.** The `createServer` call uses `enableMetadata: true` to exercise the full registry. If a future flag (e.g., `enableWorkflows: false`) gates some tools, those tools are NOT exercised by the single `createServer` call. Mitigation: the test asserts the `enableMetadata: true` universe only. Add a comment explicitly documenting this scope; a follow-up test can cover the `enableMetadata: false` subset if a new flag is added.

3. **`discoveryToolDefinition` uses a different shape than the map entries.** The `discoveryToolDefinition` is a single object, not a `Record<string, ...>`. If the normalisation logic (to make it look like a map key) is wrong, the assertion may silently skip the discovery tool. Mitigation: assert `discovery` explicitly as a named entry in the expected set; include a comment `// discovery is a singleton, not a map entry`.

## Out of scope

- Deferring: validating that each registered tool's `inputSchema` in the SDK matches the definition map's `inputSchema`. This is a schema-drift check (definition map's Zod shape vs what the SDK stores). Worst case if wrong: a tool is registered with a stale schema so `tools/list` returns the wrong input schema to MCP clients (Bug class: Verified-because-source-says-so — source has the right schema, SDK has a stale one). Accepted deferral because the `server.registerTool(...)` calls pass the definition's `inputSchema` directly — there is no transformation between map entry and registration.
- Deferring: testing `tools/call` dispatch. The existing `contract.test.ts` and per-handler unit tests cover dispatch shapes. Worst case if wrong: a handler is registered under the wrong name (Bug 4 class). Accepted because the registered tool names are the definition map keys, and the new test asserts key == registered name.

## References

- packages/twenty-mcp/CLAUDE.md (R1–R6 evaluation rules, Flawed framings catalog, before-shipping checklist)
- packages/twenty-mcp/src/server.ts:56–341 (all `registerTool` calls)
- packages/twenty-mcp/src/__tests__/coverage.test.ts (existing structural coverage — does NOT exercise SDK boundary)
- packages/twenty-mcp/src/__tests__/contract.test.ts (existing contract test — does NOT exercise SDK boundary)
- packages/twenty-mcp/plans/issue-2-apply-plan-sha256-canonicalization-opaque-audit-round-1.md (LOW 2 — original finding)
- packages/twenty-mcp/plans/low-backlog.md (cross-cutting LOWs tracking)

## Implementation notes
> Implemented: 2026-05-02T00:00:00Z

### Files changed
packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts (new file, 96 lines)

### Diff stat
1 file created: src/__tests__/sdk-boundary.test.ts (+96 lines)
No production files changed.

### Test results

**Test 1: Primary — 2 assertions pass**
```
=== npx jest src/__tests__/sdk-boundary.test.ts --config jest.config.ts ===
PASS src/__tests__/sdk-boundary.test.ts
  sdk-boundary: tools/list vs definition maps (enableMetadata: true)
    ✓ every definition key is registered (no defined-but-not-registered tools) (5 ms)
    ✓ every registered name has a definition key (no stray registrations) (2 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
=== exit: 0 ===
```
PASS

**Test 2: Regression — remove `metadata_compute_plan_hash` registerTool call**
```
FAIL src/__tests__/sdk-boundary.test.ts
  ✕ every definition key is registered (no defined-but-not-registered tools)
  ✓ every registered name has a definition key (no stray registrations)
  Expected  Array []
  Received  Array [ "metadata_compute_plan_hash" ]
=== exit: 1 ===
```
PASS (test correctly fails; server.ts restored)

**Test 3: Regression — add `metadata_test_tool` key to viewToolDefinitions without registerTool**
```
FAIL src/__tests__/sdk-boundary.test.ts
  ✕ every definition key is registered (no defined-but-not-registered tools)
  ✓ every registered name has a definition key (no stray registrations)
  Expected  Array []
  Received  Array [ "metadata_test_tool" ]
=== exit: 1 ===
```
PASS (test correctly fails; views.ts restored)

**Test 4: Full unit suite**
```
15 test suites, 171 tests — all passing (was 14 suites / 169 tests before this change)
=== exit: 0 ===
```
PASS

**Test 5: TypeScript typecheck**
```
npx tsc --noEmit — 0 errors
NX Successfully ran target typecheck for project twenty-mcp
=== exit: 0 ===
```
PASS

### Approach chosen
Used `InMemoryTransport.createLinkedPair()` + SDK `Client.listTools()` (the portable protocol-message approach, not `server._registeredTools`). The `Client` class at `@modelcontextprotocol/sdk ^1.18.0` exposes `listTools()` as a first-class public method — confirmed from type definitions. Both ends connected concurrently via `Promise.all([server.connect(...), client.connect(...)])` to avoid the initialization handshake deadlock.

### Surprises
- The plan mentioned `server.listTools()` as a possible approach but the `McpServer` class does not expose `listTools()` directly — only `Client` does. The InMemoryTransport approach was used as stated in the plan's fallback, and it worked cleanly on the first attempt.
- Full suite went from 14 suites (169 tests) to 15 suites (171 tests) — exactly 2 new tests added, no regressions.

> Audit round 1: clean — see issue-6-sdk-tools-list-boundary-test-audit-round-1.md
> Audit round 1: LOW absorbed pre-commit (trivial-in-place): replaced misleading deadlock comment with accurate "Promise.all is idiomatic" wording
> Audit round 1: LOW backlogged (foot-gun): sdk-boundary.test.ts only exercises enableMetadata: true; foot-gun for tool migration across the flag boundary
