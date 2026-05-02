# Plan: LOW-handling policy — accumulate, threshold, sweep

## Context

Issue #2's audit returned 3 LOW findings. By the current `/audit-fix` rule, all three were "annotated to plan, no further action." LOW 1 was a real, fixable, one-line description gap that nearly shipped because nothing in the workflow surfaced it as actionable. The user caught it; we manually patched it pre-commit.

**The structural defect:** LOWs are written to `audit-round-N.md`, the plan body gets a one-line annotation, and that's it. They're:
- Not GitHub issues → `/triage-issues` doesn't pick them up.
- Not in any active plan's `## Out of scope` → next plan in the same area doesn't see them.
- Discoverable only by a future implementer who happens to grep through old audit-round files.

A first-draft fix proposed sub-categorizing LOWs into `trivial-in-place / cross-cutting / foot-gun / cosmetic` and routing each differently — but that draft *still discarded foot-gun and cosmetic LOWs* (annotate-only). The user pushed back: **if we discard half the categories, what's the point of categorizing?** The right principle is **nothing gets discarded**: every LOW lands in one of three persistent destinations, and every destination eventually feeds back into the existing fix pipeline.

This plan also closes one specific "found-but-not-actioned" defect from issue #2's retrospective: the lesson about `server.ts` in the new-tool plan-file list, which has been proposed but not yet ingrained in CLAUDE.md.

---

## Core principle

**Every LOW finding goes somewhere actionable.** No "annotate and forget." Three destinations:

| Destination | What goes there | When it gets resolved |
|---|---|---|
| **A. Absorb pre-commit** | Trivial-in-place fixes (description text, comment update, single-line tweak) — concrete enough that the auditor specified the exact edit | This same audit cycle, before the supervisor's ready-for-commit report |
| **B. File as new GitHub issue (immediate)** | Cross-cutting defects — real bugs that aren't specific to this fix's scope; warrant their own focused fix later | `/triage-issues` picks up → standard plan → standard pipeline → standard close |
| **C. Backlog → sweep at threshold** | Foot-guns and cosmetic items — individually too small to justify a focused fix, but real findings that should be acted on eventually | Accumulated in `packages/<pkg>/plans/low-backlog.md`. When count ≥ threshold OR on demand, **a single batched GitHub issue is filed** containing all queued items, runs through the standard pipeline as a "low-sweep" plan |

Discard rate: 0%. Every LOW is either fixed in this cycle, becomes its own issue, or queues for a batch sweep.

The auditor's sub-categorization (4 subcategories) determines which destination each LOW takes:

| Subcategory | Destination |
|---|---|
| `trivial-in-place` | A — absorb pre-commit |
| `cross-cutting` | B — file new issue immediately |
| `foot-gun` | C — backlog, sweep later |
| `cosmetic` | C — backlog, sweep later |

---

## Backlog file format

One file per package: `packages/<pkg>/plans/low-backlog.md`. Tracked in git (committed alongside the plan whose audit produced the entry, so history is captured atomically). New file is created the first time a LOW lands in that package's backlog.

Schema:

```markdown
# Low-priority audit findings backlog — <package name>

Findings that the audit pipeline categorised as `foot-gun` or `cosmetic`. Each entry is **queued**
until the sweep threshold fires (count ≥ 5 by default, or manual via `/sweep-lows`); at sweep time,
the queued entries are bundled into a single GitHub issue and run through the standard
`/triage-issues → /implement-issue-fix → /audit-fix → /close-issue` pipeline.

## Queued

| Added | Source audit | Subcategory | One-line description | Suggested resolution |
|---|---|---|---|---|
| 2026-05-02 | issue-1-...-audit-round-1.md (LOW 2) | foot-gun | findUnresolved/error-message regex coupling foot-gun if regex widens | refactor findUnresolved to return both location + extracted key |
| 2026-05-02 | issue-2-...-audit-round-1.md (LOW 3) | cosmetic | redundant TwentyMcpClient import in metadata.test.ts | remove the redundant import |

## Swept (history)

| Swept on | Sweep issue | Items | Plan path | Closed in |
|---|---|---|---|---|
| (none yet) | | | | |
```

The `Queued` table grows as audits land; the `Swept (history)` table grows as sweeps fire. After a sweep closes, the queued items move to history (NOT deleted — historical traceability matters).

**Why one file per package**: matches the existing `packages/<pkg>/plans/` convention; auto-isolates cross-package noise; sweep can be per-package or all-packages depending on threshold logic.

---

## Sweep mechanics

### New skill: `/sweep-lows [--package <name>] [--force]`

**Args:**
- `--package <name>` — restrict the sweep to one package (default: all packages with `low-backlog.md`).
- `--force` — sweep even if threshold isn't met (manual override).

**Body:**

1. **Pre-flight**: token, lock, dirty-tree (same as `/triage-issues`).
2. **Scan backlogs**: for each `packages/<pkg>/plans/low-backlog.md`, count `Queued` entries.
3. **Threshold check**: default threshold is 5 per package. If `--force`, skip the check. If no package crosses threshold, exit with "no sweep needed; counts: <pkg>=N, ...".
4. **For each package crossing threshold (or all packages if `--force` and any have queued items):**
   a. **Build the sweep issue** — title: `[<pkg>] Low-priority audit findings sweep — <count> items (<dates>)`. Body: a markdown table summarising every queued item with links to source audit-round files.
   b. **File the issue** via REST.
   c. **Update the backlog**: move queued items to "Swept (history)" with the sweep issue number filled in. Save the backlog atomically.
   d. **Trigger triage**: tell the user the sweep issue was filed; recommend running `/triage-issues` to pick it up next, OR let the daily cron handle it tomorrow.
5. **Mass-sweep safeguard**: if a single sweep would file a GitHub issue with >20 items in a package, pause and ask the user before filing — that's a sign the threshold is too high and the backlog is overflowing.

The sweep skill **does not produce a plan itself**. It just files the GitHub issue. The standard pipeline takes over from there: `/triage-issues` picks up the new issue → `issue-triager` writes a "low-sweep" plan with one section per queued item → `/implement-issue-fix` → `/audit-fix` → user commit → `/close-issue`. This deliberately reuses the existing surface; no special-case plumbing.

### Threshold

Default: **5 queued items per package** triggers an auto-sweep recommendation in the `/sweep-lows` output. The user can override with `--force` to sweep at any count, or skip running the skill if they prefer to wait. (We're NOT auto-firing on every audit — the supervisor surfaces a recommendation when threshold is crossed, but the sweep itself is gated on the user explicitly running `/sweep-lows` to avoid hidden background filing.)

If we want auto-sweep on a cron later, that's an additive change (a `/schedule` registration calling `/sweep-lows`); not in v1 scope.

### Triager handling of sweep issues

The `issue-triager` agent's system prompt is **lightly extended** to recognise sweep issues (title prefix `[<pkg>] Low-priority audit findings sweep — `): when it sees one, it produces a plan that has **one numbered subsection per queued LOW**, each with its own mini Problem-statement / Reproduction / Proposed-fix / Test-plan-item. The plan's overall `## Failure modes named` is a combined R3 across all the items rather than per-item (since the failure modes for "redundant import + foot-gun comment + style drift" all rhyme: "we forget to actually do them"). Mechanical verifiers per item.

The implementer applies each item; the auditor audits the combined diff in one round. No special pipeline handling — same skills, same agents, same flow.

---

## Auditor's job change: pick a subcategory for every LOW

Each LOW finding in `audit-round-N.md` gets a subcategory tag from `{trivial-in-place, cross-cutting, foot-gun, cosmetic}`. The auditor's system prompt is updated with definitions:

| Subcategory | Definition | Auditor's marker |
|---|---|---|
| `trivial-in-place` | A specific, mechanical, in-place fix (description text, comment update, single-line tweak). No behaviour change to existing tests. | "Suggested fix: <one-line edit description>; estimated absorb time: <1min>." |
| `cross-cutting` | A real defect that's NOT specific to this fix's scope — applies to all wrappers / all metadata tools / repo-wide tooling. | "Suggested fix: file as separate issue with title `<draft>` and body `<draft>`." |
| `foot-gun` | Latent — only matters if some other change happens later (e.g., regex widens, schema evolves). | "Backlog entry: foot-gun, <one-line description>, suggested resolution: <text>." |
| `cosmetic` | Style / redundancy / no functional impact at any scale. | "Backlog entry: cosmetic, <one-line description>, suggested resolution: <text>." |

When unsure between trivial-in-place and cosmetic: **escalate to trivial-in-place** (the cost of absorbing an unnecessary one-liner is ~30 seconds; the cost of letting a real LOW slide is one tool-description-bug-#2 incident).

When unsure between cross-cutting and foot-gun: **escalate to cross-cutting** (filing an issue is more visible than the backlog; if it turns out to be over-eager, the issue can be closed as wontfix in triage).

Concrete subcategory rationale must appear in the audit-round file — `Subcategory rationale: <one sentence>`.

Schema delta to the LOW section:

```markdown
### LOW <if any> — varied routing per subcategory

1. **<title>** [TRIVIAL-IN-PLACE | CROSS-CUTTING | FOOT-GUN | COSMETIC] (file:line)
   - What: <description>
   - Why low: <reason>
   - Subcategory rationale: <one sentence>
   - Suggested action: <concrete; for trivial-in-place this is the edit; for cross-cutting this is the draft issue title+body; for foot-gun/cosmetic this is the backlog one-liner>
```

---

## Supervisor's job change: route per subcategory

The `/audit-fix` skill body's "LOW only" branch is rewritten:

```
LOW defects only (any subcategory) →
  group LOWs by subcategory.

  For each `trivial-in-place` LOW:
    apply the auditor's suggested-fix Edit;
    re-run the affected test pattern + the contract test;
    append "LOW absorbed: <short-desc>" to the plan annotation.

  For each `cross-cutting` LOW:
    file a new GitHub issue (title + body from auditor's draft);
    body must include a marker line `Source: audit-fix LOW (cross-cutting)`;
    append "LOW filed as #<n>: <short-desc>" to the plan annotation.
    [mass-cross-cutting safeguard: pause and ask user if >3 in a single round]

  For each `foot-gun` or `cosmetic` LOW:
    append the entry to packages/<pkg>/plans/low-backlog.md → Queued table;
    ensure the backlog file exists (create if first entry);
    append "LOW backlogged: <subcategory>: <short-desc>" to the plan annotation.

  After routing, if backlog count crossed threshold (5):
    surface a recommendation to the user in the final ready-for-commit report:
    "Backlog now at <n> items in <pkg>; recommend running /sweep-lows."
    (Do NOT auto-fire /sweep-lows — that's a separate user-gated action.)

  Continue to retrospective gate (step 4 of audit-fix skill body).
```

MEDIUM and HIGH/CRITICAL routing untouched.

---

## Files to modify / create

### Modify

- **`.claude/agents/issue-auditor.md`** — extend severity rubric with the 4 subcategories; update LOW report schema (subcategory tag + rationale + suggested action).
- **`.claude/skills/audit-fix/SKILL.md`** — rewrite "LOW only" branch with the routing logic above; add the threshold-recommendation surface.
- **`.claude/agents/issue-triager.md`** — add a short section: "When the issue title is `[<pkg>] Low-priority audit findings sweep — …`, treat it as a SWEEP issue: produce a plan with one numbered subsection per backlog item, combined R3 failure modes, mechanical verifiers per item."
- **`packages/twenty-mcp/CLAUDE.md`** — Before-shipping checklist: new line for LOW sub-categorization + routing; Common pitfalls: ingrain the `server.ts in plan file list` lesson (closes the issue-#2 retrospective lesson loop).

### Create

- **`.claude/skills/sweep-lows/SKILL.md`** — the new sweep skill (body described above).
- **`packages/twenty-mcp/plans/low-backlog.md`** — initial backlog file, populated retroactively with foot-gun + cosmetic LOWs from issues #1 and #2's audits (see Retroactive section below).
- **`plans/2026-05-02-low-handling-policy.md`** — verbatim archive of this plan (per existing meta-system convention).
- **`plans/README.md`** — new index row.

### Read (no modification)

- `packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution-audit-round-1.md` — for the LOW 2 (regex coupling) backlog entry.
- `packages/twenty-mcp/plans/issue-2-apply-plan-sha256-canonicalization-opaque-audit-round-1.md` — for the cross-cutting LOW 2 (issue body) and cosmetic LOW 3 (backlog entry).

---

## Retroactive application of the new policy

| Issue | LOW | Old action | New subcategory | New action |
|---|---|---|---|---|
| #1 round 1 | "broad catch comment understates swallow scope" | annotated | trivial-in-place (already absorbed in round 2) | mark as `absorbed` in audit-round-1 history |
| #1 round 1 | "findUnresolved/error-message regex coupling" | annotated | **foot-gun** | **add to `packages/twenty-mcp/plans/low-backlog.md` Queued table** |
| #2 round 1 | "byte-for-byte warning missing from new tool description" | annotated → manually absorbed | trivial-in-place (already absorbed) | mark as `absorbed` in audit-round-1 history |
| #2 round 1 | "SDK `tools/list` test gap shared by all metadata tools" | annotated | **cross-cutting** | **file as new GitHub issue** with marker `Source: audit-fix LOW (cross-cutting), filed retroactively per the LOW-handling policy ratification` |
| #2 round 1 | "redundant TwentyMcpClient import" | annotated | **cosmetic** | **add to backlog Queued table** |

After this work lands, `packages/twenty-mcp/plans/low-backlog.md` has **2 queued items** (1 foot-gun + 1 cosmetic). Threshold is 5 — no auto-sweep recommendation surfaces yet. As future audits feed entries in, the backlog will grow and eventually cross 5, triggering a sweep recommendation in the next /audit-fix's user-facing report.

---

## Pipeline pattern — how this work (and future meta-system changes) enters, plans, implements, audits, closes

```
[discovered in conversation, not GitHub]
    ↓
plan-mode plan written by supervisor
    ↓
USER approves via ExitPlanMode
(plan-mode requires user approval to exit; for meta-system, this is the right gate)
    ↓
plan archived to plans/<YYYY-MM-DD>-<slug>.md at repo root
    ↓
supervisor implements directly: edits .claude/agents/, .claude/skills/, CLAUDE.md
(NOT via issue-implementer agent — wrong toolset for harness config)
    ↓
supervisor self-audits adversarially:
  - re-read every changed file in full
  - verify rule is internally consistent (auditor schema ↔ skill routing ↔ backlog format)
  - verify no regressions in existing skills (do /triage-issues, /implement-issue-fix,
    /audit-fix, /close-issue still parse and reference valid agent/skill names?)
  - verify the new /sweep-lows skill is self-contained and the body matches the spec here
    ↓
supervisor R1 verifies (lightweight, since this is markdown):
  - markdown files have valid frontmatter
  - existing skills' agent references still resolve (issue-triager, issue-implementer, etc.)
  - the new low-backlog.md has the documented schema
    ↓
supervisor reports to user: diff stat + verification + summary
    ↓
USER commits + pushes
    ↓
done — no /close-issue (no GitHub issue), no closer agent invocation
```

**Optional:** if the change introduces a new agent with broad tool access OR changes severity rubrics across the pipeline (this plan does the latter, mildly), the supervisor can spawn `issue-auditor` with a tailored adversarial-reading-only prompt. For THIS plan, scope is contained — supervisor self-audit is sufficient.

**Retrospective for meta-system change:** optional. The plan + the diff is the record. Skip for v1.

---

## Verification

After supervisor implementation:

1. **Auditor system prompt internally consistent**: severity rubric LOW row replaced with the 4-subcategory table; LOW report schema includes subcategory tag + rationale field.
2. **Audit-fix skill internally consistent**: "LOW only" branch defines an action for each of the four subcategories; mass-cross-cutting safeguard echoes the existing mass-medium safeguard; threshold recommendation logic surfaces in the final report.
3. **Triager prompt extended** with sweep-issue handling; existing fix-issue handling unchanged.
4. **CLAUDE.md updates land verbatim**: Before-shipping checklist has the new `LOW sub-categorization + routing` line; Common pitfalls has the `server.ts in plan file list` lesson.
5. **`/sweep-lows` skill registered**: appears in available-skills on next session reload (skill files register live; we'll see it in this session as soon as the file is written).
6. **Backlog file exists**: `packages/twenty-mcp/plans/low-backlog.md` on disk with the documented schema; 2 retroactive entries in Queued table.
7. **Retroactive cross-cutting issue filed**: a new GitHub issue exists on `LazyBouy/twenty-crm` for the SDK `tools/list` test gap (issue #2's LOW 2), with the audit-finding marker.
8. **Plan archived**: `plans/2026-05-02-low-handling-policy.md` exists at repo root, byte-for-byte matching this plan-mode plan; `plans/README.md` index has a new row.
9. **No existing skill or agent regressed**: `/triage-issues`, `/implement-issue-fix`, `/audit-fix`, `/close-issue` skill bodies still parse and reference valid agent names.
10. **Cold-start (manual)**: in a fresh session, the changed agents and the new sweep skill load. (Verified by you the next time the window reloads.)

---

## Out of scope (deliberate)

- **Auto-sweep on cron** — registering a `/schedule` routine that fires `/sweep-lows` weekly. Additive in v2; the threshold-recommendation surface in `/audit-fix` already gives the user enough nudges.
- **Cross-cutting issue dedup** — when the auditor finds a cross-cutting LOW that's already filed as an issue from a prior audit, ideally comment on the existing issue rather than duplicate. v1 accepts the duplicate; v2 adds a `gh api .../issues?state=open` keyword search.
- **Auto-ingrain agent** — an agent whose only job is to draft CLAUDE.md edits from accumulated retrospective lessons. Tempting but premature; manual gestures fine for now. We DO close one specific lesson in this plan (the `server.ts` one); the structural reflex is a separate plan.
- **Per-subcategory metrics** — counting how often each subcategory fires across audits. Useful telemetry for tuning the rubric, not in scope for v1.
- **Backlog garbage collection** — entries that have sat queued for >180 days without crossing threshold. Deferred; no evidence yet that this will accumulate.
- **Per-package threshold tuning** — currently default 5 for every package. If `twenty-front` produces 100x more LOWs than `twenty-mcp` we may want a per-package config; defer until that asymmetry shows up.

---

## Critical files (paths)

**To modify:**
- `.claude/agents/issue-auditor.md`
- `.claude/agents/issue-triager.md` (sweep-issue recognition)
- `.claude/skills/audit-fix/SKILL.md`
- `packages/twenty-mcp/CLAUDE.md`

**To create:**
- `.claude/skills/sweep-lows/SKILL.md`
- `packages/twenty-mcp/plans/low-backlog.md` (with 2 retroactive entries)
- `plans/2026-05-02-low-handling-policy.md` (verbatim archive)

**To file (retroactive demo):**
- New GitHub issue on `LazyBouy/twenty-crm` for the SDK `tools/list` test gap

**To update (existing file, line):**
- `plans/README.md` — new index row
