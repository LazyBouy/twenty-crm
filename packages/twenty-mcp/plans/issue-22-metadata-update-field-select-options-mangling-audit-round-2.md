# Audit report: metadata_update_field SELECT options mangling (#22) — round 2

> Plan: packages/twenty-mcp/plans/issue-22-metadata-update-field-select-options-mangling.md
> Round: 2
> Audited: 2026-06-27T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | `tsc --noEmit` clean, zero errors. |
| Lint (`npx nx lint:diff-with-main twenty-mcp`) | **PASS** | "All matched files use Prettier code style!" Gate exits 0. Cross-checked with a direct `npx prettier --check` on the three working-tree-modified files — also clean. **Round-1 HIGH-1 (red lint gate) is resolved.** |
| Full unit suite (`jest --config jest.config.ts --testTimeout 10000`) | PASS | 17 suites, 224 tests passed, ~13s. Re-run by this auditor, not taken on the implementer's word. |
| Coverage test | PASS | 16 tests (part of the 224). Reads `inner-tool-schemas.json`; green WITHOUT the reverted fixture refresh. |
| Adjacent-callers check | OK | Only caller of `metadataUpdateField` is `server.ts:155` (force-cast `args`, no `.parse()`); only consumers of `metadataUpdateFieldInputSchema` are the handler signature + `metadataToolDefinitions.metadata_update_field.inputSchema`. Backward-compatible: `options`-absent path is unchanged (scalar test `metadata.test.ts:332` still green). |
| Live integration (SELECT + MULTI_SELECT round-trip) | NOT RE-RUN — source audited | See note below. |

**Note on the live integration test (not re-executed):** A local Twenty healthcheck on `:4440` returns `{"status":"ok"}`, suggesting a stack is up. However, both Read and Bash access to `packages/twenty-mcp/.env.local` are denied in this environment (the destructive-bash hook blocks any command referencing `.env.local`; the Read tool reports the directory denied). I therefore **cannot confirm `TWENTY_BASE_URL` points at the local stack rather than the VPS**. The round-trip suite is destructive (creates/deletes custom objects) and refuses to start unless its own runtime regex matches a local URL — but I will not launch a destructive suite whose target I cannot independently verify, and I will not bring up / reconfigure infrastructure per the prohibitions. I audited the test SOURCE in full instead (see below) and take the plan's captured live output (3 passed / 27 skipped) at face value. Confidence in the live result is therefore **medium** (source-verified, not freshly re-executed); confidence in every static gate is **high**.

## Round-1 finding verification

### HIGH-1 (round 1) — red lint gate → **RESOLVED**
- `npx nx lint:diff-with-main twenty-mcp` is green this round. Direct `npx prettier --check src/tools/metadata.ts src/__tests__/metadata.test.ts src/__tests__/integration/round-trip.test.ts` also reports all files clean.
- The manual reflow is behaviour-neutral:
  - `metadata.ts:464-465` — wrapped the object property `message: 'metadata_update_field: options could not be parsed as JSON'` onto two lines (`message:` then the string on the next line). The string literal is **byte-identical** to round 1 — no error-message content changed.
  - `round-trip.test.ts:1103-1104` and `1135-1136` — wrapped `const rawText = (result.content[0] as { … }).text;` so `.text` moves to a continuation line. Pure formatting; no semantic change.
- Full unit suite re-run after confirming the reflow: 224/224 green. The reflow did not alter behaviour.

### MEDIUM-1 (round 1) — dropped MULTI_SELECT round-trip → **RESOLVED (added, substantive, leak-safe)**
- A real `describeIfDestructive('integration: metadata_update_field MULTI_SELECT options (issue #22 R3)', …)` block now exists at `round-trip.test.ts:1154-1331`.
- **Not vacuous.** `beforeAll` (1) defensively deletes any stale `mcpIssue22MultiSelectFixture` object, (2) creates a fresh custom object, (3) creates a `MULTI_SELECT` field seeded with two options (`TAG_A`, `TAG_B`). The single `it` adds a third option (`TAG_C`) via `metadata_update_field` and asserts: `result.isError !== true`; `rawText` does **not** match `/map is not a function/` (the exact #22 regression); `parsed['id'] === multiSelectFieldId`; and `returnedOptions.length === 3` — i.e. it proves the option was **actually added**, not merely that the call didn't throw.
- **Leak-safe.** `fixtureObjectId` is assigned at line 1236 — strictly BEFORE the field-creation block (1244+) that can throw. So if field creation fails, `fixtureObjectId` is already set and `afterAll` (1285-1294) deletes the object (cascading to the field). Jest runs `afterAll` even when `beforeAll` throws and even when an `it` assertion throws. The `it` body creates nothing (it only updates an existing field), so there is no in-test resource to leak. No teardown gap found.

### LOW-1 / LOW-3 (round 1) — unrelated fixture hunks → **RESOLVED (reverted, out of diff)**
- `git status` does NOT list `tools-catalog.json` or `inner-tool-schemas.json`. `git diff HEAD -- <both files>` is empty (exit 0).
- Coverage test (which reads `inner-tool-schemas.json`) is green without the reverted refresh — the #22 fix never needed it. Confirmed.
- Working-tree diff is now scoped to exactly: `src/tools/metadata.ts`, `src/__tests__/metadata.test.ts`, `src/__tests__/integration/round-trip.test.ts` (plus `plans/low-backlog.md`, the LOW-2 backlog append, and the plan/audit markdown — none of which are source).

### LOW-2 (round 1) — over-strict options array branch [FOOT-GUN] → routed to backlog
- Confirmed the supervisor appended a single Queued-table row to `plans/low-backlog.md` capturing LOW-2 verbatim (foot-gun: the union array branch requires `value`/`label`/`color`, stricter than Twenty's freeform inner schema; bites only if SDK-side `.parse()` is ever enabled). No source change. Correctly persisted.

## Defects found

### CRITICAL — none.

### HIGH — none.

### MEDIUM — none.

### LOW — none new this round.

(Round-1 LOWs are all resolved or backlogged as documented above; no new LOWs were introduced by the revision.)

## Adversarial pass on the revision itself (new, previously-unaudited code)

- **Did the reflow alter a string literal's content?** No. Diffed the reflowed `metadata.ts` error-message string and the two `round-trip.test.ts` continuation lines against round 1 — only whitespace/line-break placement changed. The `'options could not be parsed as JSON'` and `'options must be an array'` messages are intact.
- **Does the MULTI_SELECT test leak its fixture if an assertion throws?** No — `fixtureObjectId` is set before the throwable field-creation step; `afterAll` is unconditional and runs on `beforeAll`/`it` throw. (Detailed above.)
- **New typecheck/lint issue from the reflow or the new block?** No. Typecheck clean; lint clean; each `as any` in the new test code is paired with an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` (lines 1097, 1311 in round-trip; 363, 416 in metadata.test) and the lint gate is green.
- **`console.log`/`console.debug` left behind?** None in any changed file.
- **Swallowed errors introduced?** No new `catch {}`. The handler's only `catch` (string `JSON.parse` failure) returns a clear `isError: true` envelope — same as round 1.
- **MULTI_SELECT seeds with options at create time** — `create_field_metadata` with a `MULTI_SELECT` `options` array — and the create path is NOT covered by the #22 coercion (out of scope per the plan). If a future transport double-encodes options on the *create* path, this `beforeAll` would surface it as a setup failure (with a descriptive thrown error), not a silent miss. Acceptable; already named in the plan's Out-of-scope as a deferred follow-up.

## Adversarial pre-mortem (R3 against the round-2 diff)

1. **Live integration result is trusted, not re-verified by the auditor.** Because `.env.local` is access-denied here, the 3-test live pass is taken from the plan's captured output. If the local stack's workspace state differs from capture-time (e.g. a `mcpIssue22*Fixture` object lingering from a crashed run), the defensive stale-cleanup in `beforeAll` handles it — but a genuinely new resolver-shape difference on MULTI_SELECT would only be caught by an actual live run the auditor did not perform. Bounded: the handler is provably field-type-agnostic by reading, and the SELECT path IS exercised live per the captured output.
2. **The `as any` casts in the new tests mask the real advertised schema.** The tests pass `options` through `as any`, bypassing `metadataUpdateFieldInputSchema`. This is appropriate (the tests target the handler's runtime coercion, not the Zod schema) but means the tests would still pass even if the schema's union branch regressed. The schema itself is exercised only at the SDK boundary, which `server.ts:155` does not enforce (no `.parse()`). Net: schema correctness for `options` has no mechanical verifier today — consistent with LOW-2's foot-gun framing, not a new defect.
3. **A future MULTI_SELECT `options` update that needs `id`-preservation semantics is untested.** Both #22 tests only *add* an option; neither exercises deleting or re-ordering existing options, which is where Twenty's `id`-preservation rule (described in the schema's `.describe`) actually bites. If an agent omits an existing option's `id` intending to keep it, Twenty deletes it — and no test catches that. Out of scope for the #22 regression (which is the `.map` array-vs-string bug), but a real next-hour failure mode for a careless caller. Candidate follow-up, not a blocker.

## Recommendations to supervisor

- Block commit: **no** — zero critical, zero high. Round-1 HIGH-1 (lint) is mechanically confirmed resolved; round-1 MEDIUM-1 (MULTI_SELECT) is resolved by a substantive, leak-safe live test; round-1 LOW-1/LOW-3 (fixture hunks) are reverted and out of the diff; LOW-2 (foot-gun) is backlogged.
- File new issues: 0 (round-1 MEDIUM-1 was implemented rather than deferred, so no follow-up issue is needed for it). Optional: the R3 #3 `id`-preservation gap above could be filed as a small hardening issue, but it is out of #22's scope — supervisor's call, not a defect.
- Annotate / route lows: 0 new. Round-1 LOW-2 already in `plans/low-backlog.md`.
- Confidence in this audit: **high** for all static gates, handler logic, adjacent-caller compatibility, reflow behaviour-neutrality, and the new MULTI_SELECT test's leak-safety + non-vacuousness. **Medium** only on the live integration *execution*, which I did not re-run (`.env.local` access-denied; I will not launch a destructive suite against an unverified target nor bring up infrastructure) — I audited the test source in full and relied on the plan's captured live output.

## Retrospective

Round 2 is a clean pass (zero critical, zero high). The consolidated retrospective is written to `issue-22-metadata-update-field-select-options-mangling-retrospective.md`.
