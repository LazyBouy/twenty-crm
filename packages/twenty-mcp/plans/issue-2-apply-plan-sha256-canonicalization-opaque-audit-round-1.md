# Audit report: metadata_apply_plan expectedSha256 canonicalization is opaque — round 1

> Plan: packages/twenty-mcp/plans/issue-2-apply-plan-sha256-canonicalization-opaque.md
> Round: 1
> Audited: 2026-05-02T00:00:00Z
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check (`npx nx typecheck twenty-mcp`) | PASS | "Successfully ran target typecheck for project twenty-mcp" — zero TS errors. |
| Lint (`npx nx lint twenty-mcp`) | FAIL — pre-existing | `Failed to parse oxlint configuration file. /packages/twenty-mcp/.oxlintrc.json No such file or directory`. The file is genuinely absent on disk; the project.json `lint` target references a config that does not exist. **Confirmed pre-existing baseline drift** (same failure mode as plan #1's audit) — not a defect introduced by this diff. The prettier sub-step also flags formatting drift on `metadata.ts`, `server.ts`, and `metadata.test.ts`, but I verified by `git stash` that the SAME three files fail prettier on the un-modified baseline (lines 91, 156, 161, 167 of metadata.ts already fail formatting before this diff existed). The new diff lines (e.g. `metadataComputePlanHashInputSchema` at 213-216, `metadataComputePlanHash` handler at 425-428) match the surrounding file's existing condensed style; they would themselves be reformatted by `prettier --write`, but they are consistent with the file's pre-existing house style. |
| Full unit suite (`cd packages/twenty-mcp && npx jest --config jest.config.ts`) | PASS | 12 suites, 153 tests, 9.78s. Matches plan prediction (150 baseline + 3 new). |
| Adjacent-callers check | OK | Grepped `metadataComputePlanHash` and `metadata_compute_plan_hash` across `packages/twenty-mcp/src` — registrations land only in `tools/metadata.ts` (handler + schema + tool definition), `__tests__/metadata.test.ts` (3 new tests), and `server.ts` (one new `registerTool` block). No stale references; no dispatcher entries needed (the handler does not appear in `APPLY_PLAN_DISPATCH`). The `expectedSha256` field is consumed only inside `metadataApplyPlan` (lines 433-447) which is unchanged by this diff. |

## Defects found

### CRITICAL — none

### HIGH — none

### MEDIUM — none rising to a new issue

### LOW — annotate to Implementation notes

1. **Failure-mode-#2 warning is missing from the description text** (metadata.ts:670-676)
   - What: The plan's R3 failure mode #2 ("caller computes the hash on a DIFFERENT mutations array than the one passed to `apply_plan`") suggested the description "should emphasise that the mutations array passed to `metadata_compute_plan_hash` must be byte-for-byte identical to the one passed to `metadata_apply_plan`." The actual `metadata_compute_plan_hash` description on disk reads: "Returns the expectedSha256 value for a given mutations array using the same canonical-JSON algorithm as metadata_apply_plan. Call this before apply_plan to obtain the correct hash without manual implementation. Pure — no side effects, no mutations dispatched." It does not warn about the byte-for-byte-identical requirement.
   - Why low: The existing SHA256_CHECK error message ("expectedSha256 mismatch: got X, expected Y") still surfaces this case as a clear user error. The defence-in-depth warning is "nice to have," not load-bearing — the integrity check itself catches the case.
   - Suggested annotation: "L: `metadata_compute_plan_hash` description does not explicitly warn that the mutations array must be byte-for-byte identical to the one later passed to `metadata_apply_plan`. The SHA256_CHECK error covers the case at runtime; consider adding the warning to the description if a future caller misuses the tool."

2. **No SDK-boundary `tools/list` test asserts the new tool is registered** (server.ts:157-164)
   - What: Server-level tool registration is not exercised by any unit test in `packages/twenty-mcp/src/__tests__/`. The MCP SDK's `tools/list` capability would surface `metadata_compute_plan_hash` only if `registerTool` was called, which `server.ts:157` does — but a regression that accidentally removes that block would not be caught by any existing test.
   - Why low: This gap pre-exists for ALL metadata-family tools (`metadata_query`, `metadata_create_object`, etc. — none have a `tools/list` test). The new tool inherits the same lack of coverage; this is not a regression of this diff, just a noted institutional gap.
   - Suggested annotation: "L: no SDK-boundary `tools/list` integration test exists for the metadata family — `server.ts` registration of `metadata_compute_plan_hash` is verified only by reading the diff. Same gap applies to all 9 metadata tools and is pre-existing."

3. **Implementer's surprise #3 (TwentyMcpClient explicit import) is benign but worth recording** (metadata.test.ts:6)
   - What: The implementer added `import { TwentyMcpClient } from '../twenty-mcp-client'` even though it was already resolved through `makeClient`'s inferred return type. This adds a redundant import.
   - Why low: Cosmetic; the import is used at line 21 (`as unknown as TwentyMcpClient`) to make the cast explicit. No type drift.
   - Suggested annotation: none needed — already documented in plan's "Surprises" #3.

## Adversarial pre-mortem (R3 against the diff)

1. **Caller passes a stringified-numeric `args` value (e.g. `args: { count: "42" }` vs `args: { count: 42 }`):** The `canonicalize()` function uses `JSON.stringify` for leaf values, so `"42"` and `42` produce different canonical strings (`"42"` vs `42`) and thus different hashes. If a caller computes the hash via `metadata_compute_plan_hash` with a numeric value but `apply_plan` is later called with the same payload that has been round-tripped through a JSON parse-then-re-encode (e.g. by an LLM that emits string-typed values), the SHA256_CHECK will fail. The new `metadata_compute_plan_hash` tool does not solve this — it inherits the same canonicalize. This is a known, accepted failure mode (the integrity check is doing exactly what it should), but the description doesn't mention it. **Verdict: not a defect of this diff** (the existing canonicalize behavior is unchanged), but a reminder that compute_plan_hash sidesteps spec ambiguity, not encoding ambiguity.

2. **Caller invokes `metadata_compute_plan_hash` with an empty mutations array `[]`:** The Zod schema sets `.min(1)`, so the proxy rejects this with a Zod validation error before it reaches `sha256OfMutations`. **Verdict: handled by the schema; verified at line 214 (`metadataComputePlanHashInputSchema`).**

3. **Caller invokes `metadata_compute_plan_hash` with a mutations array > 50 items:** The Zod schema sets `.max(50)`, matching the upper bound on `metadata_apply_plan`. **Verdict: handled by the schema; the input cap is consistent.**

(All three modes either resolve cleanly or are accepted-by-design properties of canonicalize. No new bug class is introduced by the diff.)

## Verification of supervisor's specific gaps

1. **Type check** — PASS. No type errors. The `server.ts` edit is a verbatim copy of the surrounding pattern (e.g. lines 149-156, the `metadata_get_calling_actor` registration) with the only differences being the tool name string, the `metadataToolDefinitions` key, and the handler dropped from `async (args) =>` to `(args) =>` because `metadataComputePlanHash` is synchronous. The MCP SDK's `ToolCallback` type accepts both sync and async handlers (`SendResultT | Promise<SendResultT>`, verified in `node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.d.ts:250`). No type drift.

2. **Lint baseline** — confirmed by `git stash`/`git stash pop`: the prettier formatting drift on `metadata.ts`, `server.ts`, `metadata.test.ts` exists on baseline (lines 91, 156, 161, 167 of metadata.ts already fail). The diff's new lines themselves match the surrounding house style. The oxlint failure is from a missing `.oxlintrc.json` config file — pre-existing tooling issue, not this diff's fault.

3. **`server.ts` edit verification** — VERIFIED MECHANICAL.
   - The new block (server.ts:157-164) sits inside the `if (enableMetadata) { … }` gate (line 95), so the new tool is correctly opt-in via `TWENTY_MCP_ENABLE_METADATA=true`.
   - It uses `server.registerTool('metadata_compute_plan_hash', metadataToolDefinitions.metadata_compute_plan_hash, …)` — the same shape as the 8 sibling metadata-family `registerTool` calls (lines 102-170).
   - The handler binding `(args) => metadata.metadataComputePlanHash(args as Parameters<typeof metadata.metadataComputePlanHash>[0])` mirrors the sibling pattern; only the `async` keyword is dropped (correct because the handler is synchronous).
   - No DIFFERENT tools added; no unrelated handlers; no different transport or namespace; no different env flag. The implementer's "mechanical consequence" claim is accurate. **Not scope-widening.**

4. **Test mock quality** —
   - `compute_plan_hash returns same hash` (line 715): asserts `parsed.hash === sha256OfMutations(mutations)` — uses the wrapper's source-of-truth function, not a hardcoded hex string. Correct: changing canonicalize would still pass THIS test, but would break the existing `accepts a matching expectedSha256` test (line 198) AND the new `hash round-trip` test (line 732), so the diff is defended on multiple fronts. **No "tested-because-mock-passes" risk.**
   - `hash round-trip apply succeeds` (line 732): computes hash via `metadataComputePlanHash`, parses it, passes to `metadataApplyPlan`. Asserts `applyResult.isError === false`, `parsed.failed === null`, AND `toolsCall called exactly once`. Genuine end-to-end round-trip; if the hash were stale the SHA256_CHECK would fire (verified by line 181 sibling test). **Genuine round-trip.**
   - `compute_plan_hash is pure` (line 752): asserts BOTH `toolsCall` AND `graphqlMutation` are NOT called. **Correctly addresses the supervisor's gap-4 concern.**

5. **Description text on disk** (metadata.ts:230-236) — VERIFIED. The multi-line description matches the plan's Secondary Fix block verbatim, with `\n` separators rendering as line breaks. No truncation, no paraphrasing.

6. **Catalog/contract test verification** — VERIFIED. `coverage.test.ts` extracts `toolName: '<X>'` literals and GraphQL operation names; `metadata_compute_plan_hash` has neither (it's pure), so no entry is needed. `contract.test.ts` validates wrapper-to-Twenty forwarding shapes; since compute_plan_hash forwards to nothing, no contract test entry is needed. The implementer's note explaining this is correct. The full suite (153/153) confirms both tests pass.

7. **Discovery surface** — partial. `discovery.ts` summarizes Twenty's INNER catalog (the response from Twenty's `/mcp` endpoint), not wrapper tools. Wrapper tools become discoverable via the MCP SDK's `tools/list` capability when `registerTool` is called. The new tool IS registered (server.ts:157), so it will appear in `tools/list`. No test exercises this at the SDK boundary, but that gap pre-exists for all metadata tools (LOW #2 above).

8. **`--testPathPattern=` vs `--testPathPatterns=`** — VERIFIED. The implementer's plan annotations use the plural form (`--testPathPatterns=`) in all four targeted test commands (Implementation notes, lines 196-249). The new tests' descriptions in `metadata.test.ts:714-763` use neither form. No singular form remains in test names.

9. **MEDIUM-3 (JSON.parse OOM)** — does not apply. `metadataComputePlanHash` is a pure function that calls `sha256OfMutations`, which passes `args.mutations` through `canonicalize()` (recursive `JSON.stringify` of values). The `.max(50)` Zod cap on the array bounds the input size. No `JSON.parse` of an unbounded string is introduced.

10. **MEDIUM-1 (whole-string regex)** — confirmed not applicable; this plan has no placeholder logic.

## Recommendations to supervisor

- Block commit: **no**
- File new issues: 0
- Annotate to plan: 2 LOW items (failure-mode-#2 description warning; SDK `tools/list` test gap)
- Confidence in this audit: **high** — typecheck clean, full test suite green, surprises verified as mechanical, three new tests genuinely exercise the new behavior (not mock-circular), description on disk matches plan verbatim, and the canonicalize algorithm is unchanged (no regression risk to the existing `expectedSha256` round-trip).
