# Audit report: SDK tools/list boundary test for metadata tools — round 1

> Plan: packages/twenty-mcp/plans/issue-6-sdk-tools-list-boundary-test.md
> Round: 1
> Audited: 2026-05-02T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check | PASS | `npx nx typecheck twenty-mcp` — 0 errors. |
| Lint (diff-with-main) | N/A | `twenty-mcp` package has no lint target configured (`project.json` has `"lint": {}` and no ESLint config file in the package or repo root). Pre-existing condition; not a defect of this change. Recorded as `INCONCLUSIVE` per the auditor playbook for tooling gaps. |
| Full unit suite | PASS | `cd packages/twenty-mcp && NODE_ENV=test npx jest --config jest.config.ts` — 15 suites, 171 tests, all passing in 17.9s. Suite count went from 14 to 15 and test count from 169 to 171, matching the plan's claim (+2 new tests). |
| Adjacent-callers check | OK | `createServer` has only two call sites in production: `src/index.ts` (HTTP entry) and the new test. No other test imports it. No port collision risk (InMemoryTransport is in-process). |
| Independent regression A (defined-but-not-registered) | PASS | I removed the `metadata_compute_plan_hash` registerTool block via a regex-driven mutation, ran the boundary test, and observed `Test 1 fails / Test 2 passes` with `Received Array ["metadata_compute_plan_hash"]`. Restored cleanly (39 calls before and after). |
| Independent regression B (stray registration) | PASS | I injected an extra `server.registerTool('stray_test_tool', ...)` call before the closing brace of the `if (enableMetadata)` block, ran the test, and observed `Test 2 fails / Test 1 passes` with `Received Array ["stray_test_tool"]`. Restored cleanly. |
| Deadlock claim verification | INVALID CLAIM | I rewrote `Promise.all([...])` to two sequential `await ...connect(...)` calls and ran the test. It passed in 2.5s with no hang. Sequential ordering does NOT deadlock — see Defect L1 below. |

### Why the deadlock comment is wrong (auditor's reasoning)

I read `node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js` and `shared/protocol.js` and `client/index.js`:

1. `Protocol.connect(transport)` (the base) sets `transport.onmessage = handler` then calls `await transport.start()`.
2. `InMemoryTransport.start()` only drains its own `_messageQueue` (initially empty) — it does NOT wait for any incoming traffic.
3. So `await server.connect(serverTransport)` returns immediately after wiring the server's `onmessage` handler.
4. `Client.connect(clientTransport)` then runs `super.connect(...)` (which wires the client's `onmessage`) and only then sends the `initialize` request.
5. By the time the initialize request is sent via `clientTransport.send(...)` → `serverTransport.onmessage(message)`, the server's handler has been set for many event-loop ticks. No deadlock is possible.

Empirical confirmation: the sequential variant ran to completion in 2.5s under `--detectOpenHandles`. The "sequential await would deadlock" comment in the test (lines 64-65) is factually wrong. `Promise.all` is harmless but the rationale is misleading.

## Defects found

### CRITICAL — none.
### HIGH — none.
### MEDIUM — none.

### LOW — 2

1. **Test comment claims a non-existent deadlock** [TRIVIAL-IN-PLACE] (`src/__tests__/sdk-boundary.test.ts:64-65`)
   - What: The comment says `// Connect both ends concurrently — each side is waiting for the other's / initialization handshake; sequential await would deadlock.` This is empirically false: I verified that swapping `Promise.all([server.connect(...), client.connect(...)])` for two sequential `await ...connect(...)` calls runs the test green in 2.5s. The SDK's `InMemoryTransport.start()` does not wait for any message; it only drains its initial (empty) queue. The client's `initialize` request is sent only after both `onmessage` handlers are wired.
   - Why low: the code path itself is correct (Promise.all works), and the comment is a future-maintainer hazard rather than a runtime defect. Future contributors who refactor based on the comment's claim will inherit a wrong mental model.
   - Subcategory rationale: `trivial-in-place`, not `cosmetic`, because the comment makes a falsifiable technical claim that is wrong — fixing it is a sub-30-second edit and the cost of leaving a wrong-but-confident comment is L4 ("uncertain pending verification" treated as truth) drift. Not `foot-gun` because the code is fine; only the rationale is wrong.
   - Suggested action: replace the two-line comment at `sdk-boundary.test.ts:64-65` with: `// Connect both ends concurrently. Sequential awaits also work (InMemoryTransport.start() / does not block on traffic), but Promise.all is idiomatic for in-process MCP setups.` Estimated absorb time: 1 min.

2. **`enableMetadata: false` universe is not exercised** [FOOT-GUN] (`src/__tests__/sdk-boundary.test.ts:48-95`)
   - What: The boundary test only runs `createServer({ enableMetadata: true })`. It would NOT catch a regression where a tool that should be `enableMetadata: true`-only (e.g., `metadata_query`) is accidentally moved out of the `if (enableMetadata)` block and registered always — because under `enableMetadata: true`, "registered always" still passes both assertions. Likewise, if someone moves `link_note_to_record` *into* the `if (enableMetadata)` block, the test under `enableMetadata: true` still passes but real `enableMetadata: false` deployments would lose `link_note_to_record`. The test comment claims "the enableMetadata: false subset is covered implicitly since those tools are also present in the full registry" — that claim covers existence of the keys but NOT the partition between always-registered and metadata-gated.
   - Why low: the plan explicitly deferred this in failure-mode #2 with documented rationale; the partition is structurally stable today (one `if` block); future flag additions (e.g., `enableWorkflows: false`) would have the same scoping problem and warrant a parametrised version of this test.
   - Subcategory rationale: `foot-gun`, not `cross-cutting`, because the latent risk only surfaces if (a) someone refactors the gating boundary in `server.ts` or (b) a new flag is added. Not `trivial-in-place` because adding a second `describe` block with `enableMetadata: false` is a real test-design decision (what's the expected universe?) that should be batched with the next gating-boundary change.
   - Suggested action: backlog (foot-gun): add `enableMetadata: false` boundary test (assert registered set equals `{discovery, search_records, get_record, create_record, update_record, delete_record, link_note_to_record}`); resolution: parametrise the existing `describe` over both flag values, expected sets diverge by exactly the seven non-baseline families.

The supervisor (`/audit-fix` skill) routes per subcategory: trivial-in-place → absorb pre-commit; cross-cutting → file new issue; foot-gun/cosmetic → backlog Queued table for later sweep via `/sweep-lows`.

## Adversarial pre-mortem (R3 against the diff)

1. **SDK upgrade changes `client.listTools()` shape (e.g., adds pagination cursor or returns a `Promise<{ tools, nextCursor }>` that callers must drain).** The current test uses `const { tools } = await client.listTools();` and assumes `tools` is the complete set in one call. If a future MCP SDK adds `nextCursor` semantics, the test would silently see only the first page and fail spuriously when the registry exceeds the page size. Today's 39 tools is well under any reasonable page size, so this is latent. Mitigation would be to follow `nextCursor` in a loop. Recorded as a foot-gun, not blocking — the plan already names this in failure-mode #1.

2. **`McpServer` is never explicitly closed; only `client.close()` runs.** `InMemoryTransport.close()` cascades (`await other?.close()`), so this is fine for the linked pair, but if a future maintainer adds a second transport to the same server (e.g., to test multi-transport behaviour), they may be surprised when only one side cleans up. `--detectOpenHandles` showed no warnings today, so this is observational. Worst case: a future test's `afterAll` leaks the server's protocol-level abort controllers.

3. **The test depends on `enableMetadata: true` being a static boolean.** If `createServer` ever gets richer per-family flags (e.g., `enableWorkflows`, `enableViews`), the existing test will silently still pass when `enableWorkflows: true` is the default and silently fail (with a misleading "stray registration" message) when it becomes opt-in. The bigger systemic gap is that the test doesn't take its expected set as a function of flags — it hard-codes the union. Tied to LOW #2.

## Recommendations to supervisor

- Block commit: no
- File new issues: 0
- Annotate to plan: 2 (both LOW; one trivial-in-place, one foot-gun)
- Confidence in this audit: high — I independently reproduced both regressions claimed by the implementer (defined-but-not-registered, stray registration), verified the SDK-source-level reasoning behind the deadlock claim being wrong, and ran the full suite to completion. The implementer's notes are accurate on the test count, the registration count (39), and the regression behaviours; the only inaccuracy is the deadlock comment, which is harmless but misleading.
