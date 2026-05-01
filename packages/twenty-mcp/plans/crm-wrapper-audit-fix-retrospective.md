# Retrospective: CRM wrapper audit + fix

Companion to [crm-wrapper-audit-fix.md](./crm-wrapper-audit-fix.md). What happened, why it shipped, and what we change going forward so this class of bug doesn't recur.

## What happened

The MCP proxy's CRM convenience tools (`create_record`, `update_record`, `search_records`) accepted agent input in a wrapper-friendly shape (`{object, data: {…}}`, `{object, filter: {…}}`) and forwarded the wrapper itself — so Twenty's per-object inner tools (`create_company`, `find_people`, etc.), which are `additionalProperties: false` and expect field keys at the top level, rejected the call with `Object company doesn't have any "data" field`. The wrapper had also invented two args that don't exist on Twenty (`query`, `fields` for search), giving agents a misleading schema.

The unit test suite passed. The bug shipped. Real workflows attempting writes burned ~1.1M tokens to error retries before someone diagnosed the wrapper rather than the agent.

## Why it shipped — root causes (in order of cost)

1. **Mock-based wire tests verified what the wrapper *did*, not what Twenty *would accept*.** `crm.test.ts` had `expect(toolsCall).toHaveBeenCalledWith('execute_tool', { toolName: 'create_person', arguments: { data: {…} } })`. That assertion *passed* the buggy implementation — the test was self-consistent with the bug. There was no contract verification against the real downstream API.

2. **Wrapper schemas drifted from the wrapped API.** `searchInputSchema` declared `query` and `fields` — neither exists on Twenty's `find_<plural>`. `createInputSchema` and `updateInputSchema` wrapped field values under `data`, contradicting Twenty's `additionalProperties: false` schemas. The wrapper described an interface that wasn't real.

3. **An earlier audit flagged uncertainty and we deferred verification.** During the first build of `crm.ts`, an exploration step had reported the search filter shape as "uncertain — pending live verification." That uncertainty became a TODO that nobody picked up. By the time the bug hit production, the cost of verifying then was 1.1M tokens vs. ~10 minutes of source-reading at the time.

4. **No live integration test as a final safety net.** Even a single end-to-end CRUD round-trip against the docker-compose Twenty would have failed loudly the first time it ran and caught all three bugs at once. The package had unit tests + Storybook-style mocks but no "actually call the thing" lane.

5. **The package grew before the contract was locked down.** The first surface (CRM CRUD) shipped with the contract bug latent. Then four more tool families (metadata, views, workflows, access) were added on top of the same template. By the time the bug surfaced, the audit perimeter was 5× larger than it needed to be.

## Why mocks didn't catch it (the deeper structural defect)

A mock-based test for an integration layer is testing the layer against itself. If the test author and the implementation author share the same mental model — and that model is wrong — the test rubber-stamps the bug. The only way to detect this class of error is to compare the layer's output against a contract derived from somewhere the layer didn't write: the source schema, a recorded fixture, or a live system.

We had none of those.

## Lessons (apply to every wrapper / proxy / adapter we build)

### L1. The contract lives in the wrapped system, not the wrapper.
Schemas should be **captured from** the source of truth (read the factory; call `learn_tools`; snapshot the OpenAPI doc), not transcribed by hand. Hand-transcription introduces silent drift. Where capture isn't possible, copy the schema with a `// SOURCE:` link to the file it came from, and a CI step that re-verifies on schedule.

### L2. Mocks pass when the spec passes — that's not a property of correctness.
A wire-shape mock test is fine for asserting "we send N requests in the expected order" — but it cannot validate the *content* of those requests against the downstream contract. Add at least one of:
- **Schema-fixture validation** with ajv (or equivalent), where the fixture is captured, not authored.
- **Structural invariants** — e.g., "this payload must not contain wrapper-only keys." Cheap, catches whole bug classes.
- **Live-fire integration**, gated behind an env flag so it's opt-in for fast unit runs but available in CI / pre-merge.

### L3. Don't invent fields on the wrapper that don't exist on the wrapped API.
The temptation is to add ergonomic-looking args (`query`, `fields`, `where`) so the wrapper "feels nicer." But every imagined arg is a lie agents will trust and a maintenance burden when the real API changes. If you really need a translation layer — e.g., `query` → `name LIKE %X%` — implement the translation explicitly, document the mapping, and contract-test that it produces a payload the real API accepts.

### L4. Treat audit findings labelled "uncertain" as blockers.
"Uncertain pending live verification" means *we don't know if this works* — same epistemic status as "broken." Resolve uncertainty before the work ships, even if it means another 30 minutes of source-reading. Carrying ambiguity into production multiplies its cost.

### L5. Lock the contract before scaling the surface.
Adding 4 new tool families on top of a CRUD foundation that hadn't been verified compounded the audit cost when the bug finally surfaced. Pattern: prove the first instance works against live → freeze the wrapper template → grow. The "freeze" is enforced by the contract test layer.

### L6. Tool descriptions ARE the contract for LLMs.
A schema field labelled `data: object — field values for the new record` is a contract. If agents have to discover via trial-and-error that fields go top-level, the description is wrong. Audit descriptions whenever the schema changes — they're not "comments," they're the only signal an agent has at call time.

### L7. The cost of a bug in a wrapper layer is paid by every consumer.
Unlike a bug in business code (which one team finds and fixes), a wrapper bug is silently amortized across every workflow, every agent retry, every "hmm, this MCP tool seems flaky" hour. Wrapper layers deserve disproportionate test rigor relative to their LOC because their blast radius is disproportionate.

## Process changes implemented in this fix

- **Contract test layer** (`src/__tests__/contract.test.ts`) — every wrapper handler is invoked through a capturing mock client, the forwarded payload is validated against `inner-tool-schemas.json` using ajv + structural invariants. 16 contract tests across 5 wrapper files. This is the layer that would have caught the bug.
- **Schema fixture** (`src/__tests__/fixtures/inner-tool-schemas.json`) — initially hand-curated from Twenty source files, designed to be **refreshed** (not edited) via the capture script.
- **Capture script** (`scripts/capture-inner-schemas.ts`) — connects to a live Twenty, calls `learn_tools` for the wrapped inner-tool names, writes the result to the fixture. Re-run on Twenty version bumps. The fixture's `forbiddenTopLevel` invariants survive the refresh.
- **Live-fire integration test** (`src/__tests__/integration/round-trip.test.ts`) — gated behind `TWENTY_MCP_INTEGRATION=1`. Runs the full create → search → get → update → delete lifecycle against a real Twenty. Skipped by default so unit runs stay sub-10s.
- **`discovery` tool description tightened** — explicitly tells agents to call `discovery({focus: "<inner_tool>"})` for the authoritative schema before invoking convenience CRUD tools.
- **CRM tool descriptions rewritten** to remove the misleading wrapper language and reflect that the wrapper SPREADS `data` / `filter` for them.

## What we did not change (and why)

- **Did not redesign the convenience tools to a flat-arg model** (`{object, …fields}`). That would force `additionalProperties: true` on the wrapper schema and weaken Zod validation. The current "wrapper-then-flatten" approach keeps the agent-facing schema tight and pushes spreading to the boundary. Defer.
- **Did not modify the 4 clean wrapper files** (`metadata`, `views`, `workflows`, `access`). The audit confirmed they're correct. Touching them would risk regressions for no benefit.

## Open follow-ups (not blocking, worth tracking)

- **Run the capture script against the production VPS** to refresh the fixture with the *exact* schemas the deployed Twenty version emits — the hand-curated starter is shape-correct but not byte-identical.
- **Add the contract test as a pre-merge gate in CI.** Today it runs locally; nothing forces it.
- **Add a periodic "drift" check** — a CI job (weekly?) that re-runs the capture script and fails if the resulting fixture differs from the committed one. This is the early-warning signal for an upstream Twenty schema change.
- **Audit `metadata_apply_plan` more deeply.** It dispatches to multiple ops via a switch table; the contract test only covers a handful. Worth extending coverage when there's appetite.
- **Consider deprecating `query`/`fields` from any other wrapper schemas that may have the same fabrication.** A grep across the wrapper files would tell us.

## TL;DR for the next contributor

1. **If you're building a wrapper or proxy: write the contract test FIRST.** A capturing mock + a schema fixture takes ~30 minutes and prevents the entire bug class.
2. **Never hand-author a downstream schema.** Capture it. Snapshot it. Diff it on changes.
3. **A passing mock test is not a green light to ship.** A passing contract test is.
4. **"Uncertain pending live verification" = "broken until proven."** Verify before you merge.
