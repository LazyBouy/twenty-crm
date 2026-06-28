# Retrospective: metadata_update_field SELECT options mangling — "options.map is not a function"

> Issue(s): #22
> Plan: packages/twenty-mcp/plans/issue-22-metadata-update-field-select-options-mangling.md
> Audit cycles: 2 (round 1 BLOCKED on lint; round 2 clean)
> Commit: <pending — filled by closer post-commit>
> Written: 2026-06-27T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| R1 gate: capture the wire shape before coding (Hypothesis A — schema opaqueness → client may stringify the array) | Confirmed Hypothesis A. Probe showed a real JS array arrives intact (Path A); a JSON-stringified array arrives as a string and would be forwarded verbatim to Twenty (Path B), reproducing `.map is not a function`. Fix addresses both schema advertisement (union) and handler coercion (string→JSON.parse→Array.isArray). |
| Unit test — real array forwarded as-is | Present (`metadata.test.ts:352`), asserts `toolsCall` receives a real array (`Array.isArray` true). Green. |
| Unit test — stringified array coerced to real array | Present (`metadata.test.ts:381`), asserts coercion to the exact array. Green. |
| Unit test — non-array non-string options rejected | Present (`metadata.test.ts:410`), asserts `isError` + `update_field_metadata` NOT called. Green. |
| Live SELECT round-trip (create object+field, add option, assert no `.map` error) | Implemented `round-trip.test.ts:942-1146`; plan reports 2 live passes. Auditor verified the source; did not re-execute (`.env.local` access-denied). |
| Failure-mode #1 — schema tightening blocks the double-encoded string it is meant to fix | Mitigated by the union (`z.array(...) ∨ z.string()`). Confirmed: not enforced at the boundary today (`server.ts:155` force-casts, no `.parse()`), so the union is advisory; the handler coercion is the real enforcement. |
| Failure-mode #2 — R1 reveals Hypothesis B (SDK double-encoding) instead | Two-part fix is hypothesis-agnostic; the `typeof options === 'string' → JSON.parse` branch covers B regardless. No change needed. |
| Failure-mode #3 — MULTI_SELECT shares the options path but isn't tested | **This is the one that surfaced in audit.** Round 1 caught that the planned MULTI_SELECT live test was dropped (MEDIUM-1). Round 2: a substantive, leak-safe MULTI_SELECT round-trip was added (`round-trip.test.ts:1154-1331`) that adds a third option and asserts `length === 3` + no `.map` error. Mitigation now holds mechanically. |

## Audit journey

Round 1: BLOCKED on 1 HIGH — `npx nx lint:diff-with-main twenty-mcp` was red (prettier `--check` failed on `metadata.ts` + `round-trip.test.ts`; lines over 80-col). Root cause was an evaluation-process miss: the implementer ran typecheck + jest + capture + live integration, all green, but never ran the lint gate — the **Audited-because-tests-passed / green-jest-≠-green-lint** framing. Also flagged 1 MEDIUM (dropped MULTI_SELECT live test — the plan's own R3 mitigation #3) and 3 LOWs (LOW-1/LOW-3 unrelated fixture-file churn from the capture script; LOW-2 foot-gun: options union branch stricter than Twenty's freeform inner schema).

Response to round 1: implementer manually reflowed the 3 prettier-flagged lines (behaviour-neutral, string literals byte-identical); added the MULTI_SELECT live round-trip block; reverted the two unrelated fixture hunks (`tools-catalog.json`, `inner-tool-schemas.json`). Supervisor backlogged LOW-2 (foot-gun) to `plans/low-backlog.md`; LOW-1/LOW-3 resolved by the revert.

Round 2 (final): clean. Re-ran all mechanical gates independently — typecheck PASS, lint:diff-with-main PASS (cross-checked with direct `prettier --check`), full unit suite 224/224 PASS, coverage PASS without the reverted fixtures. Verified the MULTI_SELECT test is non-vacuous (asserts the option was actually added) and leak-safe (`fixtureObjectId` set before any throwable step; `afterAll` unconditional). Confirmed the two fixture files are out of the diff. Adversarial pass on the new/reflowed code found no new defect. Live integration NOT re-executed (`.env.local` access-denied; auditor will not launch a destructive suite against an unverified target nor bring up infrastructure) — source audited in full, plan's captured live output trusted.

## Defects routed but not blocking

- Filed as new issues (medium): none. Round-1 MEDIUM-1 (MULTI_SELECT live test) was **implemented** in the revision rather than deferred, so no follow-up issue is needed.
- Backlogged as low: 1 — LOW-2 (foot-gun) appended to `plans/low-backlog.md` Queued table: the `metadataUpdateFieldInputSchema.options` union array branch requires `value`/`label`/`color`, stricter than Twenty's freeform inner `options` schema; over-rejects valid color-less payloads IF SDK-side `.parse()` is ever enabled for this tool.
- Resolved by revert: LOW-1 (`tools-catalog.json` 84-line unrelated drift) + LOW-3 (`inner-tool-schemas.json` timestamp-only bump) — both reverted, no longer in the diff.
- Optional hardening (out of #22 scope, not filed): no test exercises `id`-preservation / deletion semantics on a MULTI_SELECT options update (the schema's documented "omit id ⇒ delete" rule). Supervisor's call whether to file.

## Surprises

1. **System fields reject `options` updates.** The first integration attempt used the `fileCategory` system SELECT field; Twenty returned "System fields only allow updating: universalSettings, isActive." The test had to create a custom object + custom SELECT field to exercise the options path — hence the per-block fixture object created in `beforeAll` and torn down in `afterAll`.
2. **Twenty's `update_field_metadata` returns the updated field object directly**, not a `{success: true}` envelope. Assertions were corrected to check `parsed['id'] === fieldId` and absence of `map is not a function` (and, for the round-2 MULTI_SELECT test, `options.length === 3`).
3. **Green jest masked a red lint gate (round 1 HIGH-1).** The implementer's notes reported every gate green except the one they didn't run. The package's own checklist lists `lint:diff-with-main` as a required mechanical gate; skipping it is the exact "Audited-because-tests-passed" framing the package CLAUDE.md warns against. This is the headline lesson of this issue.
4. **`.env.local` is access-denied to the auditor in this environment** (both Read and the destructive-bash hook block it). Consequence: the auditor cannot independently confirm the integration suite targets local vs VPS, so the live run was source-audited, not re-executed. This is a recurring auditor constraint worth codifying (see Lessons).

## Lessons for institutional memory

For each lesson, propose where it should ingrain. The supervisor decides whether to wire it in — auditor only proposes.

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L_green-jest-≠-green-lint: "Full unit suite green" is NOT "before-shipping gates green." `lint:diff-with-main` (prettier `--check`) is a distinct required gate; run it explicitly before declaring done. A green jest run with a red lint gate is the **Audited-because-tests-passed** framing. | `packages/twenty-mcp/CLAUDE.md` — add a row to the Lessons table (e.g. L12) AND a one-line emphasis in the "Mechanical gates" checklist that lint is independent of jest | This codebase already enumerates the mechanical gates; the gap was treating jest-green as a proxy for all gates. The lesson is wrapper-class-general but the checklist that should have caught it lives here. |
| L_options-coercion-pattern: when a wrapper forwards an array-typed field that an MCP client may stringify (schema-opaque `z.unknown()`), defend with a handler-level `string→JSON.parse→Array.isArray` coercion AND advertise a union (`z.array ∨ z.string`). The schema hint alone is insufficient because `server.ts` does not `.parse()` incoming args. | `packages/twenty-mcp/CLAUDE.md` — Lessons table | Generalizes beyond #22: the same array-vs-stringified-array hazard applies to any future wrapper field (e.g. `metadataCreateFieldInputSchema.options`, still `z.unknown()` per Out-of-scope). |
| L_auditor-env-denied: when `.env.*` is access-denied, the auditor cannot verify a destructive integration suite's target and MUST NOT launch it or bring up infrastructure — audit the test source and explicitly record "live not re-executed; trusted plan's captured output." | root `CLAUDE.md` is too broad; better as a note in the auditor's operating constraints (agent prompt) — propose recording in `packages/twenty-mcp/plans/` audit conventions if such a doc exists | Procedural, auditor-specific; complements L13 (auditor never mutates working-tree files). Keeps the "do not bring up the stack to make a gate pass" rule honest. |
| (n/a) | (no ingrain) | The system-field-rejects-options and no-success-envelope surprises are Twenty-resolver specifics already captured in the test comments + plan notes; too narrow for a CLAUDE.md rule. |

## Diff summary

```
 .../src/__tests__/integration/round-trip.test.ts   | 403 +++++++++++++++++++++
 packages/twenty-mcp/src/__tests__/metadata.test.ts |  82 +++++
 packages/twenty-mcp/src/tools/metadata.ts          |  68 +++-
 3 files changed, 550 insertions(+), 3 deletions(-)
```
(Plus non-source: `plans/low-backlog.md` +1 line for LOW-2; the plan + audit-round markdown files.)
