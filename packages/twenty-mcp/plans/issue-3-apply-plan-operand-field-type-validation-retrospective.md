# Retrospective: metadata_apply_plan operand-for-field-type validation

> Issue(s): #3
> Plan: packages/twenty-mcp/plans/issue-3-apply-plan-operand-field-type-validation.md
> Audit cycles: 2 (round 1 BLOCKED with 3 critical + 4 high; round 2 CLEAN)
> Commit: pending — filled by closer post-commit
> Written: 2026-05-02T20:35:00Z

## Forecast vs actual

| Plan said (round 2) | What happened |
|---|---|
| Parser unpacks the array shape from `get_field_metadata` (Twenty returns `Entity[]`, not single object) | Implemented: `views.ts:107` parses as `Array<{type?: string; id?: string}>`, with explicit `Array.isArray && length === 0` fail-closed before `parsed[0]?.type` extraction. Verified against live Twenty: response IS `[{...DATE_TIME row...}]`. |
| `FIELD_TYPE_OPERAND_MAP` byte-for-byte matches twenty-front's `FILTER_OPERANDS_MAP`; verified at test time | Implemented: `views-coverage.test.ts` parses twenty-front's source via balanced-brace + regex scan, expanding `...emptyOperands` and `...relationOperands` aliases. Auditor verified by hand all 21 field types match. CI now fails on drift. |
| `UPDATE_VIEW_FILTER` without `fieldMetadataId` fails closed at BOTH layers | Implemented: Layer 1 (`views.ts:352`) and Layer 2 (`metadata.ts:545-554`) both fail closed via shared `assertOperandCompatible` import. Same function, no drift surface. |
| Tool descriptions include the per-field-type operand allow-list + validation note | Implemented: `OPERAND_MATRIX_DESCRIPTION` template literal embedded in both `metadata_create_view_filter` and `metadata_update_view_filter` descriptions; `metadata_update_view_filter` additionally instructs to supply `fieldMetadataId`. |
| Fixture entries CAPTURED via `scripts/capture-inner-schemas.ts`, NOT hand-authored | Implemented: capture script extended with `get_field_metadata` and `get_view_filters` in `STATIC_INNER_TOOL_NAMES`. Auditor verified named entries are byte-identical copies of the numeric-key captures (no synthesis). The captured `get-field-metadata-sample.json` is a real response with `type: "DATE_TIME", name: "createdAt"`. |
| Integration round-trip test runs live (no defer) | Implemented: 1 new test in `round-trip.test.ts` asserting the wrapper rejects `GREATER_THAN_OR_EQUAL` on a real DATE_TIME field BEFORE reaching Twenty. Test passes on the local stack. Auditor verified zero filter rows leaked into the database (queried all 49 views). |
| **Failure mode 1: `get_field_metadata` shape evolves from `Entity[]`** — captured fixture surfaces drift; integration test catches end-to-end shape change | Did not surface during this audit. The captured fixture is a real array from the live stack; if Twenty changes shape, the next capture will diff. Mitigation holds. |
| **Failure mode 2: matrix drift between wrapper and twenty-front** — coverage test fails CI on add/remove of types or operands | Coverage test is mechanical and passes today; auditor flagged a foot-gun (M-2): if twenty-front adds a new spread alias, the regex parser silently misses operands. Filed as follow-up issue. |
| **Failure mode 3: agent loops indefinitely on UPDATE_VIEW_FILTER fail-closed** | Mitigation in place (error message includes `Look up via metadata_query({kind: 'view_filters', args: {viewId: <viewId>}})`). Not exercised by any test today; LLM-loop behaviour is not unit-testable. Acceptable. |
| **Failure mode 4: console.warn for unknown types is silent in production** | Acknowledged trade-off. Mitigation: matrix-coverage test ensures all KNOWN types are validated; only genuinely-new Twenty types fall through. The mass-fail-open of round 1 (9 missing types) cannot recur because the coverage test enforces parity. |
| **Failure mode 5: integration test asserts plan-level failure but other mutations succeed** | Mitigated by using a single-mutation plan; `applied: []` and `failed.op === 'CREATE_VIEW_FILTER'` is an unambiguous assertion. |
| **Failure mode 6: layers drift when one is updated and the other isn't** | Both layers call the same `assertOperandCompatible` export. No drift surface by construction. The Layer-2 dispatcher test (`metadata.test.ts:788-818`) is the additional mechanical check. |

## Audit journey

**Round 1 (2026-05-02T15:13Z): BLOCKED — 3 critical + 4 high.**

The implementer wrote the validation framework but missed three structural requirements:
1. Parsed `get_field_metadata` as a single object instead of `Entity[]` — fail-opened against real Twenty.
2. `UPDATE_VIEW_FILTER` lookup attempted to call `get_view_filters({id})` — but the inner tool requires `viewId`, not `id` (and there is no inner tool that returns a single filter by id).
3. Hand-transcribed `FIELD_TYPE_OPERAND_MAP` from a prose description — got TEXT/EMAILS/FULL_NAME wrong (included spurious IS/IS_NOT) and was missing 9 field types entirely (ADDRESS, LINKS, PHONES, RAW_JSON, FILES, RATING, ACTOR, UUID, TS_VECTOR).
4. Layer 2 (`apply_plan`) silently skipped validation when `fieldMetadataId` was absent — exactly the bug class the original incident hit.
5. Hand-authored fixture entries instead of capturing them (L1 violation: "capture, don't transcribe"). The `$shape` summary for `get_view_filters` was wrong (said `viewId?` is optional; actual schema requires it).
6. Tool descriptions did not mention validation, leaving agents in retry loops on `isError: true`.
7. Integration test was deferred ("local Twenty stack not reachable"). Every defect would have been caught by a live integration run.

The supervisor reverted the round-1 implementation, revised the plan with explicit pre-implementation prerequisites (capture script extension; fixture capture; integration test marked REQUIRED no-defer), and re-implemented from the revised plan.

**Round 2 (2026-05-02T20:30Z): CLEAN — 0 critical, 0 high, 3 medium, 3 low.**

All 7 round-1 defects (C-1, C-2, C-3, H-1, H-2, H-3, H-4) verified closed:
- Parser unpacks array; tests use real shape; captured fixture confirms.
- UPDATE_VIEW_FILTER lookup path deleted; fails closed with remediation pointer.
- Matrix matches twenty-front (auditor verified by hand for all 21 types; mechanical test enforces).
- Both layers call the same `assertOperandCompatible`; Layer 2 fails closed; metadata.test exercises this.
- Fixture entries are byte-identical copies of real `learn_tools` captures (auditor verified programmatically).
- Tool descriptions include the matrix + validation note + UPDATE-must-include-fieldMetadataId instruction.
- Integration test passes live on local stack; auditor verified zero leakage by direct database query.

Three new mediums emerged in round 2 (filed as follow-up issues, not blockers):
- M-1: integration test's hardcoded `DATE_TIME_FIELD_ID` is workspace-scoped — fragile on fresh workspaces.
- M-2: views-coverage parser hardcodes spread-operator names — silently drifts on new spreads.
- M-3: `metadataUpdateViewFilter` forwards `fieldMetadataId` to inner tool (Twenty silently ignores; latent if Twenty hardens to `.strict()`).

Three lows routed to backlog/absorb-pre-commit:
- L-1 (cosmetic): prettier drift on changed files; deferred until `.oxlintrc.json` is added.
- L-2 (trivial-in-place): integration test could additionally assert no DB write happened; ~5min absorb.
- L-3 (foot-gun): views-coverage skip-on-missing-source should throw, not skip silently.

## Defects routed but not blocking

- Filed as new issues (medium): **3 drafted in audit-round-2 report**
  - "twenty-mcp: integration round-trip test self-discovers DATE_TIME field id instead of hardcoding" (M-1)
  - "twenty-mcp: views-coverage parser hardcodes spread-operator names — replace with TS compiler API" (M-2)
  - "twenty-mcp: metadataUpdateViewFilter strips fieldMetadataId before forwarding to inner tool" (M-3)
- Annotated as low: **3** — see audit-round-2 report; supervisor will route per `/audit-fix` skill (L-2 trivial-in-place absorbed pre-commit; L-1 cosmetic and L-3 foot-gun appended to `low-backlog.md`).

## Surprises

- **`learn_tools` returns schemas keyed by integer index, not by tool name.** The capture script was originally designed for named-key responses; static tools wound up under numeric keys (e.g., `tools["7"]`) without named entries. The implementer correctly addressed this by adding named entries that are byte-identical copies of the numeric-key entries, NOT by re-synthesising. The auditor verified this with `JSON.stringify` equality.
- **`fieldMetadataId` is a wrapper-only field; Twenty's `update_view_filter` does NOT accept it.** Twenty's `additionalProperties: false` declared in JSON schema is misleading — Zod's runtime is `passthrough` mode, not `strict`. Twenty silently ignores the extra prop today. Latent if Twenty hardens. (M-3.)
- **`IS_NOT_NULL` is in the `ViewFilterOperand` enum but does NOT appear in any twenty-front `FILTER_OPERANDS_MAP` entry.** It is used elsewhere in twenty-front for composite-field sub-field filtering, but it's not surfaced via the dropdown. Correctly classified as a `specialCaseOperands` member in the matrix-coverage test.
- **`VECTOR_SEARCH` IS in twenty-front's matrix under TS_VECTOR.** Round 1 incorrectly classified VECTOR_SEARCH as a special-case (claiming it was unused). Round 2 correctly placed it under TS_VECTOR via the byte-for-byte matrix sync.
- **The plan's preferred parser approach (TypeScript compiler API) was abandoned for a regex+balanced-brace fallback.** The implementer's regex parser is correct for today's twenty-front source but is foot-gunned against future spread aliases (M-2).
- **Lint runs are blocked by missing `packages/twenty-mcp/.oxlintrc.json`** — pre-existing infra gap from round 1's L-3. Not introduced by this fix; flagged for visibility.

## Lessons for institutional memory

For each lesson, propose where it should ingrain. The supervisor decides whether to wire it in — auditor only proposes.

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| **L1-reinforced**: TypeOrm-backed inner tools return `Promise<Entity[]>` even for single-id lookups. Parsers must always unpack array shape before dereferencing. | `packages/twenty-mcp/CLAUDE.md` — add to "Architecture invariants" section as a 5th bullet under "Twenty quirks", or to the L1 lesson row | Twenty backend pattern is wrapper-relevant (other future inner tools that read entities will have the same shape). Two of round 1's three criticals were variants of this. |
| **L1-reinforced**: When LLM mass-edits a typed map by hand (e.g. operand allow-lists, role permissions), the only safe pattern is a coverage test that reads the source file at test time and asserts byte-for-byte equality with the live ground truth. Hand-transcribed maps WILL drift. | `packages/twenty-mcp/CLAUDE.md` — add as L12 in the lessons table, OR amend L1 with a "applies to typed maps too" footnote | This is an instance of L1 ("Schemas live in the wrapped system, not the wrapper. Capture; don't transcribe.") that the wrapper-class generalities don't make explicit for derived data structures (not just GraphQL operation names). |
| **Two-layer validation requires a single shared function call.** When the same check applies at both Layer 1 (handler) and Layer 2 (apply_plan dispatcher), they must call the same exported function — never duplicate the logic. The dispatcher test must verify Layer 2 is wired (a "Layer 2 has the same fail-closed contract as Layer 1" test). | `packages/twenty-mcp/CLAUDE.md` — add as a sub-item under "Architecture invariants" #4 ("A single wrapper file must not mix endpoints") — extend to "And a single wrapper helper must serve all dispatch paths" | The original incident bypassed Layer 1 entirely (the bug was hit through `apply_plan`). Round 1 fixed Layer 1 but not Layer 2. Codifying the symmetry rule prevents the same split. |
| **`learn_tools` returns schemas keyed by integer index for tools requested via `STATIC_INNER_TOOL_NAMES`.** Named-key fixture entries must be added as byte-identical copies of the numeric-key captures, not synthesised. Verifier: `JSON.stringify(named.schema) === JSON.stringify(numbered.schema)`. | `packages/twenty-mcp/CLAUDE.md` — add to a new "Capture script quirks" section near the before-shipping checklist, OR amend `scripts/capture-inner-schemas.ts` with a comment near `extractSchemas` describing the integer-key shape. | The implementer hit this in real time and almost re-synthesised the named entries. Surfacing the quirk in CLAUDE.md prevents the same hour from being lost in the next audit cycle. |
| **Integration tests for wrapper-rejection paths must verify TWO things, not one**: (a) the wrapper returned the expected error; (b) the database has zero new rows that would prove the bad request slipped through. Without (b), a future regression that bypasses the wrapper would still match (a) if Twenty also rejects (with a different error). | `packages/twenty-mcp/CLAUDE.md` — under "Before-shipping checklist" mechanical gates: add a line item "If a new wrapper-rejection test is added, the test asserts both (a) wrapper error AND (b) post-rejection DB state" | This audit happened to catch the leakage manually. Codifying it makes the pattern repeatable. |
| **Workspace-scoped UUIDs in integration tests are brittle by design.** Tests that need a real entity should self-discover the entity (e.g. `metadata_query({kind: 'fields'}).find(f => f.type === '<TYPE>')`), not hardcode a UUID captured from the implementer's local stack. | `packages/twenty-mcp/CLAUDE.md` — under "Test environments — strict rules" — add: "Integration tests use self-discovering queries (no hardcoded UUIDs); the only literal UUIDs allowed are well-known-fakes (00000000-...)." | M-1 from this audit. The next contributor will face the same temptation; codifying the self-discovery pattern prevents recurrence. |

## Diff summary

```
 packages/twenty-mcp/scripts/capture-inner-schemas.ts                |   4 +
 packages/twenty-mcp/src/__tests__/fixtures/inner-tool-schemas.json  | 156 ++++++++++++++--
 packages/twenty-mcp/src/__tests__/fixtures/tools-catalog.json       |   2 +-
 packages/twenty-mcp/src/__tests__/integration/round-trip.test.ts    |  60 ++++++
 packages/twenty-mcp/src/__tests__/metadata.test.ts                  | 107 +++++++++++
 packages/twenty-mcp/src/__tests__/views.test.ts                     | 208 ++++++++++++++++++++-
 packages/twenty-mcp/src/tools/metadata.ts                           |  31 ++-
 packages/twenty-mcp/src/tools/views.ts                              | 164 +++++++++++++++-
 8 files changed, 701 insertions(+), 31 deletions(-)
```

Plus untracked new files:
- `packages/twenty-mcp/src/__tests__/fixtures/get-field-metadata-sample.json` (captured live response)
- `packages/twenty-mcp/src/__tests__/views-coverage.test.ts` (mechanical drift verifier)
