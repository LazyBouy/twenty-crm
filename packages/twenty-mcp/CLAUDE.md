# CLAUDE.md — twenty-mcp

This package is a thin external MCP proxy for Twenty CRM. **Read this BEFORE modifying anything in `src/tools/` or shipping a new wrapper tool.**

## What it is

- Streamable-HTTP MCP server on `:4441`
- Proxies Twenty's in-tree `/mcp` (record-crud path; gated by `canObjectBeManagedByWorkflow`)
- Bypasses the gate via Twenty's GraphQL endpoints for system objects
- 37+ typed wrappers across discovery, crm, note-targets, metadata, views, workflows, access

## Architecture invariants (memorise these)

1. **Wrappers expose typed Zod schemas to agents but forward RAW shapes to Twenty.** Agent-facing keys (`object`, `data`, `filter`) are wrapper conveniences; they MUST NOT leak into the inner-tool payload (Twenty's inner schemas are `additionalProperties: false`).
2. **THREE transports, not two:**
   - `client.toolsCall('execute_tool', …)` → Twenty's `/mcp` (record-crud; gated by `canObjectBeManagedByWorkflow`)
   - `client.graphqlMutation(query, vars, 'metadata')` → Twenty's `/metadata` GraphQL (admin: roles, permissions, api keys, object/field metadata) — **`createOne<X>` mutation convention**
   - `client.graphqlMutation(query, vars, 'graphql')` → Twenty's `/graphql` workspace data (per-object CRUD, system-object bypass for noteTarget/timelineActivity) — **`create<X>` mutation convention, NO `One` prefix**
3. **`/metadata` and `/graphql` have DISJOINT mutation sets.** A mutation that exists on one does NOT exist on the other. **Bug #4 from `plans/audit-and-safeguards.md` was caused by routing `createNoteTarget` to `/metadata`.**
4. **A single wrapper file must not mix endpoints.** If you need both, split into two files. Coverage test enforces this.

## Evaluation rules — how "done" is defined

These rules sit upstream of the lessons below. The lessons describe specific bug classes; these rules describe the evaluation process that lets bugs of any class slip through if not followed. **Six bugs shipped to production from this package; every one of them came from a violation of one of the rules below.**

### R1. "Implemented" is not "exercised"
- The phrases **"ready"**, **"framework in place"**, **"infrastructure exists"**, **"plumbed through"** are NOT synonyms for done.
- Done = exercised against a real system, with concrete evidence (actual test output, real response payload, captured fixture).
- If the thing has not been run, say `"untested, deferred — risk: <bug class>"`. Do not say `"ready"`.

### R2. Every deferral names a worst-case bug class
- "We'll do X later" is a real risk, not a scope choice.
- The cost of a deferral is what consumers pay if the deferred work surfaces a bug, not what it costs you to do later.
- If the worst case is "a bug class we have already shipped before", flag the deferral for explicit user approval. Don't quietly defer.

### R3. Adversarial pre-mortem before declaring done
- Before saying done, name three concrete failure modes that could plausibly surface in the next hour of real use.
- If you can name three with reasons, the work is not done — those are your next test cases.
- If you can name zero, you are not looking hard enough. Try again.

### R4. Every assertion has a mechanical verifier
- "The wrapper sends X" → write a test that fails when it doesn't.
- "The mutation name exists" → coverage test against captured introspection.
- "The selection set is valid" → coverage test against the type's fields.
- An assertion without a mechanical verifier is vibes. The bugs we shipped were vibes.

### R5. "Trivial-because-mechanical" is a flawed framing
- Mechanical cost (typing, flag-flipping, rerunning a script) is **not** the same as work cost.
- Work cost = mechanical cost + the consequence of being wrong about your claim.
- When something feels trivial, ask: *"What assumption am I making, and what happens if it's wrong?"* If the assumption is invisible to you but visible to a consumer, the work is not trivial.

## Flawed framings to recognize (catalog)

These are the wrong frames that produced every shipped bug. Recognize and name them in flight:

- **Trivial-because-mechanical** — small action, invisible epistemic gap. (The "just flip the metadata flag" framing in the audit cycle.)
- **Verified-because-source-says-so** — the wrapped system's source code mentions the name, so we shipped it without introspecting the deployed system. (Bug 3: `createOneRole` exists in source; deployed `noteTarget` mutation is `createNoteTarget`.)
- **Tested-because-mock-passes** — the mock was self-consistent with the wrapper; correctness against the wrapped system never entered the test. (Bug 1: cost ~1.1M tokens.)
- **Pattern-applied-without-verification** — copying a naming convention from a peer wrapper file as if it were ground truth. (Bug 5: assumed `roles` query existed; actual name is `getRoles`.)
- **Imagined-because-plausible** — a field name "feels right" so we shipped it. (Bug 6: `id` on `ObjectPermission`, a composite-key type with no `id`.)
- **Done-because-foreground-checklist-empty** — declaring work complete because the visible TODO list cleared, not because the system is verified. (The "gated tools — framework in place" framing that quietly hid bugs 5 and 6.)

When you catch yourself reaching for one of these, stop. Verify the claim or downgrade the language.

## Lessons (specific bug classes from production)

| # | Lesson |
|---|---|
| L1 | Schemas live in the wrapped system, not the wrapper. **Capture; don't transcribe.** |
| L2 | Mocks pass when the spec passes — that's not correctness. Need fixture/live validation. |
| L3 | Don't invent fields on the wrapper that don't exist downstream. |
| L4 | "Uncertain pending verification" = "broken until proven." |
| L5 | Lock the contract before scaling the surface. |
| L6 | Tool descriptions ARE the contract for LLMs. Audit them when schemas change. |
| L7 | Wrapper-layer bugs cost every consumer; rigour is justified. |
| L8 | **GraphQL mutation names ARE schema. Introspect, don't infer from peer files or resolver-factory method-keys.** |
| L9 | **`/metadata` ≠ `/graphql`.** Same query language, different schemas. Pick the right endpoint per object. |
| L10 | **GraphQL response selection sets are part of the contract.** Selecting a field that doesn't exist on the return type is the same class of bug as a wrong mutation name. Coverage test must validate selections, not just operation names. |
| L11 | **Feature flags hide bugs from default-on testing.** Lifting every flag must be part of pre-ship verification, not post-ship discovery. |

## Before-shipping checklist (REQUIRED for every PR touching `src/tools/`)

**Mechanical gates** (verifiers; failing one = the work is not done):
- [ ] `npx dotenv -e .env.local -- npx tsx scripts/capture-inner-schemas.ts` ran successfully against a local Twenty stack (refreshes `fixtures/inner-tool-schemas.json` + `fixtures/tools-catalog.json`)
- [ ] `npx dotenv -e .env.production -- npx tsx scripts/capture-graphql-schema.ts` ran successfully (refreshes `fixtures/metadata-graphql.json` + `fixtures/data-graphql.json`)
- [ ] `npx jest src/__tests__/coverage.test.ts` passes — every wrapper reference (inner tool, mutation/query name, input type, response selection set) exists on the correct endpoint
- [ ] `npx jest src/__tests__/contract.test.ts` passes
- [ ] `npx jest --testTimeout 10000` (full unit suite) is green
- [ ] If a NEW tool was added: per-tool integration smoke added to `__tests__/integration/round-trip.test.ts` AND it passed live against a **local docker-compose Twenty** (NOT VPS)
- [ ] If a NEW tool is gated behind a feature flag: the flag was lifted and the tool exercised live before this PR was opened (R-rule violation otherwise — see L11)
- [ ] If the tool uses GraphQL transport: endpoint partition explicit (`/metadata` for admin, `/graphql` for workspace data) and passed to `client.graphqlMutation(...)`

**Evaluation gates** (rules from the section above; passing the mechanical gates does not satisfy these):
- [ ] R1 satisfied: every claim of "done" has been backed by an exercised run, not just an implementation
- [ ] R2 satisfied: every deferral in this PR names its worst-case bug class explicitly
- [ ] R3 satisfied: I named three concrete failure modes that would plausibly surface in the next hour of real use, and either fixed them or documented why they're acceptable
- [ ] R4 satisfied: every assertion in the PR description has a mechanical verifier in the test suite
- [ ] R5 satisfied: nothing was skipped, deferred, or downgraded with the framing "trivial" without checking the consequence-of-wrong

**Post-deploy:**
- [ ] `vps-smoke.test.ts` ran successfully against the VPS (read-only, no destructive ops)

## Test environments — strict rules

**Two `.env` files, gitignored, never co-exist as `.env`:**

| File | Used for | Destructive ops? |
|---|---|---|
| `.env.production` | VPS-deployed Twenty (`http://100.115.12.29`) — `vps-smoke.test.ts` | ❌ NEVER. VPS is production. |
| `.env.local` | local docker-compose Twenty (`http://localhost:4440`) — `round-trip.test.ts` | ✅ allowed (local data only) |
| `.env.example` | template (committed; never holds real values) | n/a |

**Loading the right file:**
```bash
# local sweep (destructive ops permitted)
npx dotenv -e .env.local -- jest src/__tests__/integration/round-trip.test.ts

# VPS smoke (read-only)
npx dotenv -e .env.production -- jest src/__tests__/integration/vps-smoke.test.ts
```

**Triple-gating on `round-trip.test.ts` (defence in depth):**
1. `TWENTY_MCP_INTEGRATION=1` — opts in to integration mode
2. `INCLUDE_INTEGRATION=1` — jest config opts the path in
3. `MCP_INTEGRATION_DESTRUCTIVE_OK=1` — explicit acknowledgment of destructive ops

Plus a runtime URL check: if `TWENTY_BASE_URL` doesn't look like a local Twenty (regex matches `localhost`/`127.0.0.1`), the suite **refuses to start** even with the flags set.

**`vps-smoke.test.ts` (read-only) gating:**
1. `TWENTY_MCP_INTEGRATION=1` + `INCLUDE_INTEGRATION=1` (same as above)
2. `MCP_VPS_SMOKE=1`
3. **Refuses to start** if `MCP_INTEGRATION_DESTRUCTIVE_OK=1` is also set — read-only by contract.

## Deployment loop

```
LOCAL ─→  bring up local Twenty  →  full sweep on .env.local  →  fix bugs locally
                                                                       │
                                                       all green ──────┴──→ docker compose build mcp
                                                                                                │
                                                                                          ship to VPS
                                                                                                │
                                                                              VPS  ─→  vps-smoke on .env.production
```

**Never ship destructive ops to VPS.** The dev loop is local-first.

## Plans + retrospectives

See [plans/](./plans/) — every shipped fix has a plan + retrospective. **READ THEM before adding similar functionality.**

- `initial-design.md` — the original wrapper design
- `crm-wrapper-audit-fix.md` + `-retrospective.md` — bug 1 (data wrapper)
- `note-target-linking-fix.md` + `-retrospective.md` — bug 2 (workflow gate) and bug 3 (`createOne<X>` mutation name)
- `audit-and-safeguards.md` + `-retrospective.md` — bug 4 (endpoint routing), bug 5 (`getRoles` query name), bug 6 (`id` on `ObjectPermission`); the structural safeguards (3-layer coverage test); the **evaluation rules** above are the deepest output of this audit.

## Common pitfalls

- `/metadata` and `/graphql` have different mutations. Do not assume.
- `/graphql` does **NOT** use the `createOne<X>` prefix. `/metadata` does.
- System objects (`isSystem: true`) cannot be created via record-crud. Route via `/graphql`.
- Don't forward agent-facing keys (`object`, `data`, `filter`) to Twenty's flat-shape inner tools.
- The GraphQL schema is auto-generated per workspace; some types only exist after specific objects are present.
- `discovery({focus: "<name>"})` is the authoritative schema source at runtime; do not bake assumed shapes into descriptions.
