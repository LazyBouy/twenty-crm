# Retrospective: SDK tools/list boundary test for metadata tools

> Issue(s): #6
> Plan: packages/twenty-mcp/plans/issue-6-sdk-tools-list-boundary-test.md
> Audit cycles: 1 (clean on first pass)
> Commit: pending — filled by closer post-commit
> Written: 2026-05-02T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Add `src/__tests__/sdk-boundary.test.ts` with 2 tests: "all definition keys are registered" + "no stray registrations". | Both tests landed verbatim. Implementer named them "every definition key is registered (no defined-but-not-registered tools)" and "every registered name has a definition key (no stray registrations)" — the wording matches the plan's intent and both assertions are mechanically real (auditor reproduced both regression failures by mutating server.ts). |
| `server.listTools()` may not exist on `McpServer`; fall back to `InMemoryTransport.createLinkedPair()` + `client.listTools()`. | Implementer confirmed `McpServer` does not expose `listTools()` (only `Client` does) and used the InMemoryTransport path as planned. Approach exercises the SDK's real registry through the protocol message path, not an internal map — auditor verified by reading SDK source (`inMemory.js`, `protocol.js`, `client/index.js`) and by independently mutating `server.ts` to confirm the test catches both defined-but-not-registered and stray-registration regressions. |
| Failure mode 1: "SDK version drift changes `listTools()` API." | Did not surface in this round. Implementer chose the more portable transport-message path (not internal `_registeredTools`), which is the better-aligned mitigation. Foot-gun #1 in audit pre-mortem (pagination semantics) is a future-version variant of the same concern. |
| Failure mode 2: "`enableMetadata: false` path is not tested." | Surfaced as audit LOW #2 (foot-gun). The plan acknowledged the deferral; the audit recorded it explicitly so it can be batched into the next gating-boundary change. The test's comment claim "the enableMetadata: false subset is covered implicitly" is technically only true for key existence — it does not cover the gating partition itself. Annotated as a foot-gun for the backlog. |
| Failure mode 3: "discoveryToolDefinition uses a different shape than the map entries." | Did not surface. Implementer wrapped `discoveryToolDefinition` as `{ discovery: discoveryToolDefinition }` exactly as the plan specified, and the boundary test passes both assertions, confirming "discovery" is in both expected and registered sets. |
| Test plan: full unit suite remains green. | 15 suites / 171 tests, all passing in 17.9s. Test count went from 169 to 171 (+2) — exactly matches the plan's claim. |
| Test plan: typecheck stays at 0 errors. | Verified — `npx nx typecheck twenty-mcp` returns 0 errors. |

## Audit journey

Round 1 (final): clean. Mechanical gates: typecheck PASS, full suite PASS (15 suites / 171 tests), adjacent-callers OK (only `index.ts` and the new test reference `createServer`; no port collision risk since InMemoryTransport is in-process). Lint gate INCONCLUSIVE — `twenty-mcp` package has no ESLint config / `project.json` has empty `"lint": {}` — pre-existing condition, not a defect of this change.

Adversarial reproduction: the auditor independently mutated `server.ts` two ways — (a) regex-deleted the `metadata_compute_plan_hash` registerTool block, (b) injected a stray `server.registerTool('stray_test_tool', ...)` call — and confirmed the boundary test correctly fails in each case with the expected key in the failure message. Both mutations were restored cleanly (39 registerTool calls before and after).

Two LOW defects recorded:
- L1 [TRIVIAL-IN-PLACE]: the `Promise.all` comment falsely claims sequential awaits would deadlock; auditor verified empirically (sequential variant ran green in 2.5s) and from SDK source (`InMemoryTransport.start()` only drains its own queue, never blocks on traffic).
- L2 [FOOT-GUN]: `enableMetadata: false` partition is not exercised; latent risk if someone moves a tool across the `if (enableMetadata)` boundary.

No critical, high, or medium defects. Proceeded to retrospective.

## Defects routed but not blocking

- Filed as new issues (medium): none.
- Annotated as low: 2, see audit-round-1 report. Routing per audit-fix policy: L1 → absorb pre-commit (one-line edit at `sdk-boundary.test.ts:64-65`); L2 → backlog Queued table in `packages/twenty-mcp/plans/low-backlog.md`.

## Surprises

- The plan suggested `server.listTools()` as a possible direct API on `McpServer`. It is not — only `Client` exposes `listTools()`. Implementer used the documented fallback (InMemoryTransport + Client) without delay.
- Implementer's "deadlock concern" rationale for `Promise.all` is wrong: sequential awaits work fine because `InMemoryTransport.start()` does not block on incoming traffic, and both `onmessage` handlers are wired before the client emits its `initialize` request. The code is correct (Promise.all is fine); the comment is misleading. Caught only because the auditor independently empirically tested the sequential variant.
- Test count delta exactly matches the plan: +2 tests (169 → 171). No silent regressions in adjacent suites.
- The boundary test file is 96 lines — slightly larger than typical "two assertions" tests because the imports cover all six definition map sources plus discovery. This is correct, not bloat.

## Lessons for institutional memory

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L12: When wrapping an SDK with an in-memory transport, **verify the deadlock claim before writing the comment**. The cost of a false-but-confident comment is a future maintainer inheriting a wrong mental model. Empirical confirmation (run the sequential variant) takes one minute; reasoning from upstream source (`transport.start()` blocks on what?) takes five. | `packages/twenty-mcp/CLAUDE.md` (Lessons table) | Specific to this codebase's wrapper + SDK pattern; the same trap applies to any future in-memory transport reasoning (test fixtures, integration scaffolding). Belongs in the package's lessons. |
| L13: A boundary test that asserts `union(definitionMaps) == registeredNames` is the **right shape** for catching defined-but-not-registered and stray-registration regressions. The pattern generalises to any wrapper that splits "what's defined" from "what's wired up". | `packages/twenty-mcp/CLAUDE.md` (Before-shipping checklist or Lessons table — supervisor's choice) | The pattern is a structural defense, not a one-off; codifying it makes future wrappers (next family beyond access/views/workflows) immediately auditable. |
| L14: Boundary tests against feature-flag-gated registries should be **parametrised over the flag**. A single-flag test under the most-permissive setting passes through gating-boundary regressions (e.g., a tool moved across an `if (enableX)` boundary) silently. | `packages/twenty-mcp/CLAUDE.md` (Lessons table) | The plan deferred this with explicit acknowledgement, but the deferral itself is the lesson — flag-gated registries need flag-parametrised verification. Belongs near L11 ("Feature flags hide bugs from default-on testing"). |

## Diff summary

```
 packages/twenty-mcp/src/__tests__/sdk-boundary.test.ts | 96 +++++++++++++++++++++++ (new file)
 1 file created, 96 lines added.
 No production files changed.
```
