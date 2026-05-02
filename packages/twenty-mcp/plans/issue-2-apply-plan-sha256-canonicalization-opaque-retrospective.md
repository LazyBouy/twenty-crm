# Retrospective: metadata_apply_plan expectedSha256 canonicalization is opaque

> Issue(s): #2
> Plan: packages/twenty-mcp/plans/issue-2-apply-plan-sha256-canonicalization-opaque.md
> Audit cycles: 1
> Commit: pending — filled by closer post-commit
> Written: 2026-05-02T00:00:00Z

## Forecast vs actual

| Plan said | What happened |
|---|---|
| Add `metadata_compute_plan_hash` tool — pure handler returning `{ hash: <64-hex> }` | Implemented at `metadata.ts:425-428`. Synchronous, calls `sha256OfMutations(args.mutations)`. **Done as planned.** |
| Add `metadataComputePlanHashInputSchema` reusing `ApplyPlanMutation` element + `.min(1).max(50)` cap | Implemented at `metadata.ts:213-216`. Schema validated by Zod at the proxy boundary. **Done as planned.** |
| Update `expectedSha256` description to multi-line text including the canonicalize algorithm + `metadata_compute_plan_hash` pointer + Python pitfall note | Implemented at `metadata.ts:235`. **Verbatim match to plan's Secondary Fix block.** Audit confirmed no truncation, no paraphrasing. |
| Register tool with `readOnlyHint: true, idempotentHint: true` | Implemented at `metadata.ts:670-676`. **Done as planned.** |
| Tests — compute returns same hash as `sha256OfMutations` | Implemented (`metadata.test.ts:715`). Asserts wrapper handler's hash equals direct function call result. |
| Tests — hash round-trip compute → apply | Implemented (`metadata.test.ts:732`). Asserts `applyResult.isError === false`, `failed === null`, AND `toolsCall` called once. Genuine round-trip. |
| Tests — compute_plan_hash is pure | Implemented (`metadata.test.ts:752`). Asserts BOTH `toolsCall` AND `graphqlMutation` not called. |
| Failure mode #1 (caller sees stale description in cached LLM context) | Mitigation held: the new tool's existence in the catalog is the primary fix. Description update is defence-in-depth. **Not blocking.** |
| Failure mode #2 (caller computes hash on a different mutations array than apply_plan) | The plan suggested explicit byte-for-byte-identical warning in the description. Audit found the warning is **NOT** in the on-disk description. SHA256_CHECK error message still surfaces this case clearly at runtime. Routed as LOW annotation, not blocking. |
| Failure mode #3 (canonicalize diverges from RFC 8785 in edge cases) | Compute_plan_hash sidesteps this for callers using the tool. The description correctly notes "wrapper's canonical JSON" (not "canonical JSON" generic). **Mitigation held.** |
| `metadata_compute_plan_hash` not in plan's file list, server.ts edit needed | Implementer flagged as Surprise #2. Audit verified: edit follows the identical pattern as 8 sibling metadata-family tools (server.ts:102-170). Inside `if (enableMetadata)` gate (line 95). Synchronous handler `(args) =>` correctly omits `async`. **Not scope widening — mechanical consequence as claimed.** |
| 153 = 150 + 3 test count | Verified exactly. |

## Audit journey

Round 1 (final): clean.

- Mechanical gates: typecheck PASS; full unit suite 153/153 PASS; lint failure is pre-existing baseline drift (`.oxlintrc.json` missing on disk + prettier format drift on the same files in baseline — verified by `git stash` toggle). Adjacent-callers grep clean.
- Supervisor's specific gaps: all eight verified. `server.ts` edit is genuinely mechanical (matches sibling pattern); description text on disk is verbatim match to plan; test mocks assert against the wrapper's own source-of-truth function (not hardcoded values), so changing canonicalize would still pass the unit assertion but would break the existing `accepts a matching expectedSha256` test AND the new round-trip test — multi-front defence.
- Defects: 0 critical, 0 high, 0 medium, 3 LOW. Routed as plan annotations (failure-mode-#2 description warning gap; SDK `tools/list` test gap; redundant `TwentyMcpClient` import noted as benign).

## Defects routed but not blocking

- Filed as new issues (medium): none.
- Annotated as low: 2 (the third LOW — redundant import — was already covered by the implementer's Surprises #3, no annotation needed). See plan's `## Implementation notes → Audit annotations` once supervisor appends.

## Surprises

Consolidated from implementer's `## Implementation notes → Surprises` and audit findings:

1. **Jest version drift: `--testPathPattern` (singular) → `--testPathPatterns` (plural).** Jest 30.1.3 in this package requires the plural form. Same surprise the issue #1 implementer hit; same fix. Recurring institutional drift — worth ingrain.
2. **`server.ts` not listed in plan's "Proposed fix" file enumeration.** Registering a new tool in `metadataToolDefinitions` without wiring it via `registerTool` would leave it unreachable at runtime. The implementer correctly identified this as a mechanical consequence rather than scope widening. Plans for new wrapper tools should always list `server.ts` in the file list.
3. **`TwentyMcpClient` was used but not imported in the original `metadata.test.ts`.** TypeScript resolved it through `makeClient`'s inferred return type. Adding the explicit import is harmless but cosmetic.
4. **Test count: 153 = 150 + 3.** Matches plan prediction exactly.
5. **The `.oxlintrc.json` file is genuinely absent from `packages/twenty-mcp/`** — the project.json `lint` target references it but the file does not exist on disk. Pre-existing tooling baseline drift; same baseline observed in plan #1's audit. Not introduced by this diff.
6. **Prettier baseline drift exists on `metadata.ts`, `server.ts`, `metadata.test.ts` independently of this diff** (verified via `git stash`/`git stash pop`). The diff's new lines match the surrounding file's existing condensed style.

## Lessons for institutional memory

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L: When adding a new wrapper tool, the plan's file list MUST include `src/server.ts` — `metadataToolDefinitions` registration alone is unreachable at runtime without `server.registerTool`. | `packages/twenty-mcp/CLAUDE.md` "Before-shipping checklist" or "Common pitfalls" | Two consecutive plans (#1 indirectly via lessons, #2 directly) hit this; institutional gap that costs the implementer one extra Surprise per plan. Ingrain at the package level. |
| L: Jest in `twenty-mcp` is version 30.1.3, which requires `--testPathPatterns` (PLURAL), NOT `--testPathPattern` (singular). | `packages/twenty-mcp/CLAUDE.md` "Common pitfalls" | Recurring drift across plans #1 and #2; cheap to record. |
| L: For pure (no-forwarding) wrapper tools, `coverage.test.ts` and `contract.test.ts` will silently NOT validate the tool's existence — they only check tools that forward to Twenty. The tool's only structural validation is its presence in `metadataToolDefinitions` (verified by file inspection) and `server.ts` `registerTool` (verified by file inspection). Add a dedicated unit test that imports `metadataToolDefinitions` and asserts the new tool is keyed in. | `packages/twenty-mcp/CLAUDE.md` "Before-shipping checklist" — extend with a "pure-tool" branch | The existing safeguards target wrapper-to-Twenty contract bugs; pure tools have a different bug class (registration omission) that no current test catches. The auditor flagged this as LOW because it pre-exists for all metadata tools — but the gap will widen as more pure tools are added. |
| L: The `metadata_compute_plan_hash` description does NOT warn that the mutations array passed must be byte-for-byte identical to the one later passed to `metadata_apply_plan`. The SHA256_CHECK error covers this at runtime, but a clearer description would prevent a confused callsite. | (no ingrain — too narrow / one-off) | Specific to this tool's description; not a general rule. Track as a follow-up edit if the gap surfaces in user reports. |
| (n/a) | (no ingrain — too narrow / one-off) | The redundant `TwentyMcpClient` import in `metadata.test.ts` is cosmetic. |

## Diff summary
```
 packages/twenty-mcp/src/__tests__/metadata.test.ts | 51 ++++++++++++++++++++++
 packages/twenty-mcp/src/server.ts                  |  8 ++++
 packages/twenty-mcp/src/tools/metadata.ts          | 19 +++++++-
 3 files changed, 77 insertions(+), 1 deletion(-)
```
