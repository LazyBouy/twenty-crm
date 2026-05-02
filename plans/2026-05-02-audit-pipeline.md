# Plan: add a dedicated post-implementation auditor agent (Opus) + two-level audit gate

> **Archival note**: this plan and the prior agent-system plan must both be committed verbatim to `plans/` at the repo root as part of execution — see §0 below. `/root/.claude/plans/...` is a working file outside the repo; it doesn't survive plan-file overwrites between plan-mode sessions. Repo-level archival fixes that.

## 0. Archival of meta-system plans (NEW convention)

Plans split into two homes:

| Where | What lives there | Examples |
|---|---|---|
| `packages/<pkg>/plans/` | Package-scoped bug fixes / feature plans (issue-triggered) | `packages/twenty-mcp/plans/issue-1-...md` |
| `plans/` (repo root, **NEW**) | Meta-system / cross-package plans about the workflow itself | the issue-triage system, this audit pipeline |

The repo-root `plans/` folder is **gitignored-status: not yet ignored**. Add no special gitignore rules — these plans should be tracked alongside source.

### Plans to archive as part of this work

Two plans must be written verbatim to `plans/` at repo root during execution. Filenames use a date prefix for chronological ordering:

1. **`plans/2026-05-02-issue-triage-agent-system.md`** — the previous (already-approved, already-implemented) plan that created `issue-triager`, `issue-implementer`, `issue-closer` agents + their skills. Content recovery source: the conversation history block titled `## Approved Plan (edited by user):` returned by the harness after the first `ExitPlanMode` call this session (begins with the line `# Plan: GitHub-issue triage + fix workflow with project-scoped subagents`). Copy verbatim — no edits, no "minor cleanups."
2. **`plans/2026-05-02-audit-pipeline.md`** — this plan, copied verbatim from `/root/.claude/plans/i-would-like-to-enumerated-rose.md` at the moment of implementation.

Both files become committable artifacts — the user can `git add plans/` and ship them with the agent code in the same commit, so the agent system and its institutional record stay in sync.

### Going forward

Every future meta-system plan (auditor v2, new agent role, schedule infrastructure, etc.) lives at repo-root `plans/` with the same `YYYY-MM-DD-<slug>.md` convention. Per-fix plans continue to live under `packages/<pkg>/plans/` keyed by issue number. Retrospectives sit next to the plan that owns them, in either folder.

### Index — `plans/README.md` (in scope, created with the archives)

A short index file at `plans/README.md` lists every archived plan with status + one-line summary. It is committed alongside the plan files so anyone landing in the repo can scan the workflow's history at a glance. Schema:

```markdown
# `plans/` — meta-system plans for the Twenty CRM workflow

Cross-package and workflow-infrastructure plans live here. Per-fix bug plans live under `packages/<pkg>/plans/`.

## Convention

- Filename: `YYYY-MM-DD-<short-slug>.md` (date is the plan-approval date).
- Plans stay verbatim once approved — edit the next plan, don't rewrite a past one.
- Retrospectives, if written, sit next to the plan as `<plan-basename>-retrospective.md`.
- Add a row to the index below when archiving a new plan.

## Index

| Date | Plan | Status | Summary |
|---|---|---|---|
| 2026-05-02 | [issue-triage-agent-system](2026-05-02-issue-triage-agent-system.md) | implemented | First-cut agent system: `issue-triager`, `issue-implementer`, `issue-closer` + their skills; daily cron + GitHub PAT integration via `.claude/settings.local.json`. |
| 2026-05-02 | [audit-pipeline](2026-05-02-audit-pipeline.md) | implemented | Adds `issue-auditor` (Opus) + `/audit-fix` skill, severity-tiered defect routing (critical/high block, medium → new issue, low → annotate), shifts retrospective writing pre-commit, codifies R6 in `packages/twenty-mcp/CLAUDE.md`. |
```

Maintenance rule: every future archival also updates the index (one new row + bumping any prior plan's `Status` if it just landed). This is a one-line gesture at archive time; no separate workflow needed.

## Context

The existing pipeline (triager → implementer → supervisor R1 re-run → user commit gate → closer) has a **thin audit step**: the supervisor runs the test commands the plan listed, eyeballs the diff, and ships. For plan #1 today, that meant my "audit" did NOT cover: test-quality (114 lines of new test code unread), TypeScript (`tsc --noEmit` not run), lint, adjacent-code interactions (does `effectiveArgs` flowing into `argsTransform` break callers that assumed raw `m.args`?), description drift on the catalog/contract test, regex strictness vs. tool description (whole-string-only substitution not documented in the new prose), or DoS surface from `JSON.parse` on inner-tool responses. None of those caught — and any of them could be the source of bug #7.

The user wants a **two-level audit** before commit: a dedicated **Opus auditor agent** that does line-level adversarial reading of the diff + tests + adjacent code (catches what plans don't anticipate), then the supervisor (me) does an architectural-fit + cross-cutting pass on top. Defects found are severity-routed: critical/high block + restart triage, medium become new GitHub issues, low get annotated to Implementation notes. This addresses the gap between R3 ("adversarial pre-mortem before declaring done") and "actually done" — a missing rule we'll codify as **R6: post-implementation adversarial audit, by an actor distinct from the implementer**.

User decisions captured (already answered):
- **Scope**: every fix gets audited (grouping caps the cost).
- **Routing**: severity-tiered (critical/high → block + restart triage; medium → new GitHub issue; low → annotate).
- **Retroactive**: run the new auditor against plan #1's existing diff before committing #1.
- **Pipeline order**: implementer → auditor → supervisor R1 re-run → supervisor own audit → ready-for-commit.
- **CLAUDE.md update**: yes — add R6.

---

## Architecture (where the auditor fits)

```
                            existing path                          NEW
                            ─────────────                          ───
issue-triager  ────────►  plan in plans/            (unchanged)
       │
       ▼ supervisor approves                        (unchanged)
issue-implementer ─────►  diff + tests + notes     (unchanged)
       │
       ▼ implementer reports back                   (unchanged)
                                                    ┌──────────────────────────┐
              ┌────────►  ✶ AUDIT CYCLE ✶  ────────►│  issue-auditor agent     │
              │                                     │     (Opus 4.7)           │
              │                                     │  reads diff/tests/code;  │
              │                                     │  emits severity-tiered   │
              │                                     │  defect list             │
              │                                     └────────────┬─────────────┘
              │ critical/high                                    │ defects[]
              │ defect blocks                                    ▼
              │   │                              ┌──────────────────────────────────┐
              │   │                              │  CLAUDE (supervisor)             │
              │   │                              │  routes per severity:            │
              │   │ ◄────────────────────────────│    critical/high → block + loop  │
              │                                  │    medium → file new issue       │
              │     ┌────────────────────────────│    low → annotate plan           │
              │     │  AT MOST 3                 └──────────────┬───────────────────┘
              │     │  cycles before                            │ no blocking defects
              │     │  user escalation                          ▼
              │                                  ┌──────────────────────────────────┐
              │ revise plan (back to triager)    │ ✶ RETROSPECTIVE ✶  (NEW timing)  │
              │ then re-run implementer          │ Auditor writes <plan>-retro.md   │
              │                                  │ consolidating ALL cycles:        │
              │                                  │   forecast vs actual, defects    │
              │                                  │   found, rework done, lessons    │
              │                                  │   for institutional memory       │
              │                                  └──────────────┬───────────────────┘
              │                                                 │
              │                                                 ▼
              │                                  ┌──────────────────────────────────┐
              │                                  │  CLAUDE (supervisor)             │
              │                                  │  R1 re-run + own-audit pass      │
              │                                  │  (architectural fit, cross-cut)  │
              │                                  │  reviews retrospective sanity    │
              │                                  └──────────────┬───────────────────┘
              │                                                 │ all green
              │                                                 ▼
              │                            ┌─────────  USER GATE  ─────────────┐
              │                            │  reviews diff + tests + retro;     │
              │                            │  commits + pushes (or vetoes)      │
              │                            └──────────────┬─────────────────────┘
              │                                           │ commit SHA
              │                                           ▼
              │                            ┌──────────────────────────────────┐
              │                            │  issue-closer agent              │
              │                            │   (Haiku 4.5) — SIMPLIFIED       │
              │                            │  reads existing retrospective,   │
              │                            │  fills in commit SHA + diff stat,│
              │                            │  posts closing comment, closes   │
              │                            └──────────────────────────────────┘
```

Key rules:
- The auditor is a **distinct actor** from the implementer (different agent, different model, fresh context). This is what makes R6 enforceable — not the same brain checking its own work.
- The retrospective is now written **before commit, not after**. It's the auditor's final responsibility on the last (clean) audit pass. Multiple audit cycles consolidate into ONE retrospective.
- The closer's responsibilities **shrink**: it no longer writes the retrospective; it just fills in the commit SHA, posts the closing comment with links, and closes the issue.

---

## 1. The new auditor agent

**File:** `.claude/agents/issue-auditor.md`

**Frontmatter:**
```yaml
---
name: issue-auditor
description: Reads the diff produced by the issue-implementer, the plan it claims to implement, the changed source/test files, and adjacent code; emits a structured defect list with severities. On the FINAL clean pass, also writes the consolidated <plan>-retrospective.md (covering all audit cycles, forecast-vs-actual, lessons for institutional memory). Adversarial — assumes the implementation has bugs and tries to find them. Never modifies source code, never commits, never closes issues. Run automatically after issue-implementer via /audit-fix <plan-path>.
model: opus
tools: Read, Write, Bash, Grep, Glob
color: red
---
```

**Note on `tools`** — what the auditor writes vs. what it doesn't:

The auditor produces **two kinds of files**, both under `packages/<pkg>/plans/`:

1. **Per-round audit report** → `<plan-basename>-audit-round-<N>.md` — written every audit run (round 1, round 2 if a re-audit happens, etc.). Contains the structured defect list (the contract below). Persists as historical record across cycles.
2. **Final retrospective** → `<plan-basename>-retrospective.md` — written ONLY on the final clean pass (zero critical/high defects on the current round). Consolidates all audit rounds into the single pre-commit retrospective document.

`Write` (in the tools list) is used for both. `Write` creates new files OR overwrites existing ones; the auditor uses it only with the two filename patterns above. **Anything else is a hard prohibition.**

`Edit` is deliberately **omitted** — that closes off in-place edits to source, tests, plans, or CLAUDE.md. The plan-side annotations (e.g. "see `<plan>-audit-round-1.md` for full report; verdict: block") are appended by the **supervisor** using its own `Edit` access, not by the auditor. This keeps a clean line: auditor produces immutable per-round artifacts; supervisor decides how to summarise them inline in the plan.

**System-prompt responsibilities (full content goes in the agent file):**

The auditor's job is to find **defects** in an already-implemented fix. A defect is anything that means "this should not ship as-is": test gaps, type errors, lint violations, scope leaks, contract drift, regression hazards, security surfaces, performance regressions, documentation drift.

**Inputs received from the supervisor:**
- `<plan-path>` — the plan file (so the auditor knows what the implementer was supposed to do)
- The implementer has already appended `## Implementation notes` to the plan with files changed, diff stat, test results.

**Hard checklist the auditor MUST run (mechanical gates — must run, must report):**

1. **Type check**: `npx nx typecheck twenty-mcp` (or appropriate package). Capture verbatim output. Any error = critical defect.
2. **Lint**: `npx nx lint:diff-with-main twenty-mcp`. Capture verbatim output. Errors = high defect; warnings = low defect.
3. **Read every changed source file** in full (not just the diff hunks). The auditor must understand the surrounding code, not just the patch.
4. **Read every changed test file** in full. Specifically check: are the assertions actually testing the right thing, or do they pass on a stub that doesn't reflect production behavior? (Tested-because-mock-passes — a class that has shipped twice from this codebase.)
5. **Read the plan's `## Implementation notes`** to identify any "Surprises" the implementer flagged that the supervisor might have skimmed past.
6. **Grep for adjacent callers** of every modified function/symbol. For each caller, ask: does the change in calling-convention break them? (e.g. plan #1 swapped `m.args` for `effectiveArgs` in two dispatch branches — every dispatch entry's `argsTransform` and `build` callbacks need to be checked.)
7. **Grep for sibling tests** that test the modified function. Did any of them implicitly rely on the old behavior? Were they updated, removed, or left alone (silent regression)?
8. **Compare tool descriptions to behavior** for any wrapper whose handler changed. If the description says X and the handler now does Y, that's L6 contract drift.
9. **Run the test suite in two configurations**: with and without integration flags. The implementer may have skipped integration tests for valid reasons (no local stack); the auditor should at minimum run the full unit suite to catch regressions outside the plan's listed test patterns.
10. **R3-against-the-diff**: name three concrete failure modes that the diff (not the plan) introduces in the next hour of real use. If you can name three, those are unfixed defects.

**Adversarial reading checklist (qualitative gates — apply to every diff):**

- Does the diff introduce code paths that aren't covered by any test? Cite the exact lines.
- Are any new types/interfaces missing strict-mode safety (any-typed parameters, optional fields that should be required)?
- Is anything force-cast (`as <Type>`) where a runtime check would be safer?
- Does the diff rely on undocumented behavior of an upstream library/framework?
- Are there any error paths that swallow errors silently (`try { ... } catch {}`)?
- Are there any `console.log`/`console.debug` left in?
- Does the diff modify shared state (e.g. captured fixture files, snapshot files) that would surprise reviewers?
- Are there inputs the diff doesn't validate that should be (large strings, deeply-nested objects, malformed UTF-8)?

**Output format** — the auditor writes this verbatim to `<plan-basename>-audit-round-<N>.md` via `Write`, AND returns a short summary in its final message (so the supervisor can route without re-reading the whole file). The structured defect list is the contract:

```markdown
# Audit report: <plan title> — round <N>

> Plan: <plan-path>
> Round: <N>
> Audited: <ISO timestamp>
> Auditor: issue-auditor (opus)

## Mechanical gates

| Gate | Result | Notes |
|---|---|---|
| Type check | PASS / FAIL | <stderr if fail> |
| Lint (diff-with-main) | PASS / FAIL / WARN | <count of errors / warnings> |
| Full unit suite | PASS / FAIL | <test count, time> |
| Adjacent-callers check | OK / DEFECTS | <caller files inspected> |

## Defects found

### CRITICAL <if any> — blocks commit
1. **<title>** (file:line)
   - What: <description>
   - Why critical: <consequence of shipping>
   - Evidence: <verbatim test output, code snippet, or grep result>
   - Suggested fix: <concrete>

### HIGH <if any> — blocks commit
<same shape>

### MEDIUM <if any> — file as new GitHub issue
<same shape; issue title + body draft included>

### LOW <if any> — annotate to Implementation notes
<same shape; one-line annotation suggested>

## Adversarial pre-mortem (R3 against the diff)

1. <failure mode 1 introduced by the diff, not the plan>
2. <failure mode 2>
3. <failure mode 3>

## Recommendations to supervisor

- Block commit: yes / no
- File new issues: <count>
- Annotate to plan: <count>
- Confidence in this audit: <high / medium / low + reason>
```

**Hard prohibitions:**
- Never edit any source, test, plan body, or CLAUDE.md file. The single permitted `Write` target is `<plan-basename>-retrospective.md` (and only on the final clean pass).
- Never run `git commit`, `git push`, or any GitHub-mutating call.
- Never invent defects to look thorough. If the implementation looks clean, return "no defects found" — that itself is a valid output and the supervisor needs to know.
- Never apologize for mechanical gates that fail because of a tooling issue (e.g. `nx typecheck` errors that aren't in the diff). Surface them; don't hide them.
- Never write the retrospective on a non-clean pass. Retrospectives only land when the audit is settling — i.e. zero critical/high defects on the current cycle.

**Retrospective writing (final clean pass only):**

When the audit returns zero critical/high defects (medium/low are fine, they're routed but don't block), the auditor's last action is to write `<plan-basename>-retrospective.md` next to the plan. Schema:

```markdown
# Retrospective: <plan title>

> Issue(s): #<n> [(grouped: #n2)]
> Plan: <relative path to plan>
> Audit cycles: <count, including the final clean pass>
> Commit: <pending — filled by closer post-commit>
> Written: <ISO timestamp>

## Forecast vs actual

| Plan said | What happened |
|---|---|
| <test plan item 1> | <pulled from final Implementation notes> |
| <failure mode 1 hypothesis> | <did it surface during audit cycles? did the mitigation hold?> |
| <failure mode 2 hypothesis> | <…> |
| <failure mode 3 hypothesis> | <…> |

## Audit journey

Round 1: <what audit found, what was changed in response>
Round 2: <if cycle 2 happened: what changed, what was found>
...
Round N (final): clean — proceeded to retrospective.

## Defects routed but not blocking

- Filed as new issues (medium): #<n>, #<n> (titles)
- Annotated as low: <count>, see plan's `## Implementation notes → Audit annotations`

## Surprises
<consolidated from each round's Implementation notes / audit findings — even small things>

## Lessons for institutional memory

For each lesson, propose where it should ingrain. The supervisor decides whether to wire it in — auditor only proposes.

| Lesson | Suggested ingrain target | Rationale |
|---|---|---|
| L<x>: <one-line rule> | `packages/twenty-mcp/CLAUDE.md` (Lessons table) | <why this codebase is the right home> |
| L<y>: <one-line rule> | root `CLAUDE.md` (Code Conventions) | <why repo-wide> |
| L<z>: <one-line rule> | new section in `<file>` | <if no existing home> |
| (n/a) | (no ingrain — too narrow / one-off) | <reason> |

## Diff summary
<output of `git diff --stat` — keep just the stat, not the patch>
```

If on the clean pass there were ZERO defects in any prior cycle (i.e. one-shot clean) the "Audit journey" section says simply: `Round 1 (final): clean.` The retrospective still gets written — its existence is required at commit time, even when the journey was uneventful.

**Severity rubric (the auditor's job is to assign severity correctly):**

- **CRITICAL**: ships → user-visible correctness regression OR security incident. Examples: type error in production code path, broken contract with deployed Twenty (mutation/query name wrong, etc.), unhandled error path in a user-facing handler.
- **HIGH**: ships → high probability of bug surfacing in next 24h of real use. Examples: missing test coverage on the only new code path, tool description contradicts handler behavior, regression in adjacent code path that isn't caught by existing tests.
- **MEDIUM**: ships → real but bounded risk; warrants its own follow-up issue. Examples: performance regression on edge cases, missing input validation that's not exploitable today but is a future hazard, documentation gap on a new public API.
- **LOW**: ships fine; just worth recording. Examples: minor style drift, suboptimal but correct algorithm, comment clarity.

If the auditor is unsure, **escalate** — better to mark high and have the supervisor downgrade than mark medium and let it slip.

---

## 2. The new `/audit-fix` skill

**File:** `.claude/skills/audit-fix/SKILL.md`

**Args:** `<plan-path>` (required).

**Body summary** (the skill orchestrates the audit cycle, possibly across multiple rounds):

1. **Pre-flight**: confirm the plan has an `## Implementation notes` section. Without it, the implementer hasn't run yet — refuse with "no audit possible until implementer has appended Implementation notes."
2. **Determine round number**: scan `packages/<pkg>/plans/` for existing `<plan-basename>-audit-round-*.md` files; the next round number is `max(existing) + 1` (or 1 if none).
3. **Spawn `issue-auditor`** with the plan path AND the round number. Tell it: "write `<plan-basename>-audit-round-<N>.md` with your structured findings. If the round is clean (no critical/high), also write `<plan-basename>-retrospective.md` consolidating all audit-round-*.md files in this plan's series into the pre-commit retrospective."
4. **Read the audit-round file** the auditor just wrote (the supervisor reads it; this is the source of truth for routing decisions).
5. **Apply severity routing** by appending one-line annotations to the plan via supervisor `Edit`:
   - **CRITICAL/HIGH defects present** → revert state to `planned`. Append to plan: `> Audit round <N>: BLOCKED — see <plan-basename>-audit-round-<N>.md (<count> critical/<count> high)`. Report to user: "Audit blocked the fix. Plan needs revision — re-engage triager via /triage-issues, or fix in place if it's a known one-liner. After revision, re-run /implement-issue-fix and /audit-fix; this counts as round <N+1>." **The auditor will NOT have written the retrospective on a blocking pass — this is correct.**
   - **MEDIUM defects present** → for each, file a new GitHub issue via REST. Append to plan: `> Audit round <N>: medium defects → filed issues #<a>, #<b>; see <plan-basename>-audit-round-<N>.md`. Auditor will have written the retrospective.
   - **LOW defects only** → append to plan: `> Audit round <N>: low-only — see <plan-basename>-audit-round-<N>.md`. Auditor will have written the retrospective.
   - **No defects** → append to plan: `> Audit round <N>: clean — see <plan-basename>-audit-round-<N>.md`. Auditor will have written the retrospective.
6. **Retrospective gate**: when severity is medium/low/none (i.e. proceed-cases), confirm `<plan-basename>-retrospective.md` exists and is non-empty. **If the file is missing, this is a hard failure** — the auditor was supposed to write it. Surface to user. Never proceed to commit-ready state without the retrospective on disk.
7. **Hand off** to the supervisor for their R1 re-run + own-audit pass + retrospective sanity check.

**Cycle limit**: if a plan reaches **3 audit rounds** without converging to clean, the skill stops and escalates to the user: "Plan has had 3 audit cycles with persistent critical/high defects — this is a structural problem with the plan, not the implementation. Recommend abandoning this plan and triaging the issue from scratch." This prevents infinite loops on a fundamentally broken plan.

**Mass-medium safeguard**: the skill never auto-files issues without confirmation if there are MORE THAN 3 medium defects in a single round — that's a sign of a bigger structural problem, and the supervisor should look at it before flooding the issue tracker.

---

## 3. Severity routing — exact rules

| Auditor severity | Action | State change | User-visible? |
|---|---|---|---|
| CRITICAL | Block commit. Append findings to plan. State → `planned`. Loop back to triager OR explicit user override. | implementing → planned | yes (block report) |
| HIGH | Same as CRITICAL. | implementing → planned | yes |
| MEDIUM | File new issue(s) via REST. Append filed-issues list to plan. Continue cycle. | (no change — current issue continues) | yes (FYI in final report) |
| LOW | Annotate plan's Implementation notes. Continue cycle. | (no change) | no (visible in final report only as "+N low audit annotations") |

**The "file new issue" template** for medium defects:

```markdown
[twenty-mcp] <auditor's title>

Discovered during audit of #<parent issue>.

**What**: <auditor's description>
**Where**: <file:line from auditor>
**Suggested fix**: <auditor's concrete suggestion>

Filed automatically by the audit pipeline. Will be picked up in the next /triage-issues run.

Parent issue: #<n> (<plan-path>)
Audit report timestamp: <ISO>
```

**Confirmation gate**: if auditor returns >3 mediums, the supervisor pauses and reports to the user before mass-filing. Otherwise, automatic.

---

## 4. Pipeline order changes (existing skills + closer)

Three existing files are touched — surgical edits, no rewrites:

### `.claude/skills/triage-issues/SKILL.md`

Update step 3 of "the flow" to **chain via `/implement-issue-fix` then `/audit-fix`**, and require retrospective presence before reporting ready-for-commit:

```
3. Auto-chain to `/implement-issue-fix` THEN `/audit-fix`
   For each approved plan, in order of severity:
   - mark status: implementing
   - invoke /implement-issue-fix <plan-path>
   - if implementer succeeds → invoke /audit-fix <plan-path>
   - if /audit-fix returns "block" → revise plan + re-run implementer (round N+1, max 3)
   - if /audit-fix returns "clean" → confirm <plan>-retrospective.md exists
   - if retrospective missing → escalate to user (system bug; auditor should have written it)
   - mark status: awaiting-commit
   - report ready-for-commit (with retrospective link) to user
```

### `.claude/skills/implement-issue-fix/SKILL.md`

Update step 4 (independent test re-run) to clarify the order: it happens **AFTER `/audit-fix` completes** with a clean pass, and includes a retrospective sanity check:

```
4. After auditor returns clean and retrospective is on disk:
   - independently re-run the test commands (R1 — unchanged)
   - do my own architectural-fit pass (cross-cutting concerns the auditor's
     line-level focus might miss)
   - sanity-check the retrospective: forecast-vs-actual table is filled,
     lessons reference concrete ingrain targets (not vague "we should be
     more careful")
   - if any of MY checks fail, treat them as supervisor-found defects with
     the same severity rubric the auditor uses
```

This pins the order: implementer → auditor (with cycles) → retrospective written → supervisor R1 → supervisor own-audit → user.

### `.claude/agents/issue-closer.md`

The closer is **simplified** — no longer writes the retrospective. Update its system prompt:

- Remove the entire "Retrospective document" section (the retro already exists; closer doesn't author it).
- Add a new responsibility: **fill in `Commit:` and `Diff summary:` fields** in the existing retrospective. Use a single `Edit` call to swap `Commit: <pending — filled by closer post-commit>` for `Commit: <full SHA>` and append the actual diff stat.
- The closing comment template still links to plan + retrospective (both already exist). The summary line in the comment can be pulled from the retrospective's "Forecast vs actual" first row or the plan's title.
- Hard prohibition reaffirmed: no source code edits; the only `Edit` permitted is to fill in pending fields in the retrospective file.

Cost benefit: the closer becomes faster + simpler; retrospective is more accurate (written by the actor with full audit-cycle context, not by the closer who would only see the final state).

---

## 5. Retrospective placement (the institutional-memory bridge)

The retrospective shifts from **post-commit** (closer-authored) to **pre-commit** (auditor-authored, on the final clean pass). Two reasons this matters beyond timing:

1. **Required at commit gate**: the user reviews diff + tests + retrospective together before deciding to commit. The user sees the proposed lessons and their suggested ingrain targets before committing — they can edit the retrospective in their working tree if they want to adjust the proposal. (Retrospective is in `packages/<pkg>/plans/`, gitignored from the broader `.claude/` rules but tracked under `packages/...` — same as the plan.)

2. **Lessons → institutional memory ingrain (deferred-decision)**: each lesson in the retrospective names a *suggested ingrain target* (which CLAUDE.md, which section, or "n/a — too narrow"). The auditor proposes; the supervisor + user decide whether to wire it in. We deliberately defer the *mechanics* of ingrain (auto-PR? manual edit? batch monthly?) — for now it's a manual decision. The plan only ensures the lessons are captured and proposed at commit time.

   Concretely, after the user commits the fix and runs `/close-issue`, they may also choose to edit the relevant CLAUDE.md to ingrain the lesson. That's a separate gesture (one or more `Edit` calls), not automated. If the lesson is high-value, the supervisor can offer to schedule a follow-up agent to draft the CLAUDE.md edit as a separate PR — but only if the user wants that.

The retrospective being on disk before commit is the **non-negotiable** part. The ingrain mechanism is the negotiable part.

---

## 6. CLAUDE.md update — the new R6 rule

**File:** `packages/twenty-mcp/CLAUDE.md`

Add R6 after the existing R5 in the "Evaluation rules" section:

```markdown
### R6. Post-implementation adversarial audit, by a different actor

- After the implementer reports done, an actor that did NOT write the implementation reads the diff, tests, and adjacent code adversarially and emits a defect list.
- For this codebase: the auditor is the `issue-auditor` agent (Opus, separate session, no shared context with implementer). The supervisor then does its own pass on top.
- "The implementer ran the tests" is not the same as "an adversarial reader looked for what the tests don't cover." R3 is a pre-implementation pre-mortem; R6 is a post-implementation pre-mortem against the actual diff.
- Defect routing is severity-tiered: critical/high block; medium files a follow-up; low annotates. See `.claude/skills/audit-fix/SKILL.md` for the rubric.
- Skipping the audit because "this fix is small" or "the implementer was careful" is exactly the trivial-because-mechanical framing R5 warns against.
```

Also extend the "Before-shipping checklist" — Mechanical gates section gets a new line:

```markdown
- [ ] `/audit-fix <plan-path>` ran and reported no critical/high defects (medium → filed as follow-up; low → annotated)
```

And add a new entry to the "Flawed framings" catalog:

```markdown
- **Audited-because-tests-passed** — the implementer's own test suite is green, so the work shipped without a distinct adversarial reader. Tests cover what their author thought to test; an auditor's job is to find what the author missed. (R6 violation.)
```

---

## 7. Retroactive audit on plan #1

Before plan #1 is committed, run the new auditor against its existing diff:

```
/audit-fix packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution.md
```

Expected outcomes (any of these is fine — we're testing the system, not blame-checking):
- **Clean**: auditor returns no defects → plan #1 ships as-is, but we have evidence the audit pipeline works on a real diff.
- **Low/medium defects only**: documented or filed; #1 ships with annotations.
- **High/critical defects**: #1's plan goes back to revision before commit. This would be the most valuable case — caught a real bug we'd otherwise have shipped.

This retroactive run is **part of this work**, not a separate task. It validates the system end-to-end before we onboard plans #2 and #3.

---

## 8. Files

**To create (infrastructure):**
- `.claude/agents/issue-auditor.md`
- `.claude/skills/audit-fix/SKILL.md`

**To create (archival — see §0):**
- `plans/2026-05-02-issue-triage-agent-system.md` — verbatim copy of the previously-approved plan (recovered from conversation history).
- `plans/2026-05-02-audit-pipeline.md` — verbatim copy of this plan.
- `plans/README.md` — index with convention notes + initial 2-row table.

**Files produced at runtime (per fix; not part of this plan's create list, but documented here for clarity):**
- `packages/<pkg>/plans/<plan-basename>-audit-round-<N>.md` — one per audit round, written by the auditor.
- `packages/<pkg>/plans/<plan-basename>-retrospective.md` — once, on the final clean pass, written by the auditor; commit SHA + diff summary filled in by the closer post-commit.

**To modify:**
- `.claude/skills/triage-issues/SKILL.md` — chain step 3 picks up `/audit-fix` between `/implement-issue-fix` and ready-for-commit; require retrospective presence before reporting commit-ready.
- `.claude/skills/implement-issue-fix/SKILL.md` — pipeline order clarified (auditor + retrospective run before supervisor R1); supervisor sanity-checks retrospective.
- `.claude/agents/issue-closer.md` — remove retrospective-writing responsibility; closer just fills in pending `Commit:`/`Diff summary:` fields in the existing retrospective and posts the closing comment.
- `packages/twenty-mcp/CLAUDE.md` — add R6, extend Before-shipping checklist, add "Audited-because-tests-passed" framing.

**To read (as part of execution; not modified):**
- `packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution.md` — for the retroactive audit run.
- The diff for plan #1 (`git diff -- packages/twenty-mcp/src/`).

---

## 9. Verification (test the audit pipeline end-to-end)

After all the above lands, the verification is the retroactive audit on plan #1:

1. **Spawn auditor** on plan #1 via `/audit-fix packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution.md`.
2. **Confirm the audit-round file exists on disk** at `packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution-audit-round-1.md` with the exact section headers from the contract above. (The auditor's message-level summary alone is not enough — the file must be on disk.)
3. **Confirm severity routing fires correctly**:
   - If 0 defects: auditor proceeds straight to retrospective writing, status unchanged.
   - If low only: `## Audit annotations — round N` subsection in Implementation notes; auditor still writes retrospective.
   - If medium: new GitHub issue(s) filed; their numbers appear in plan; auditor still writes retrospective.
   - If high/critical: state reverts to `planned`, `## Audit findings — round N` section appended; **no retrospective written**; supervisor reports block.
4. **Confirm retrospective is on disk** at `packages/twenty-mcp/plans/issue-1-apply-plan-placeholder-resolution-retrospective.md` after a clean pass. Its `## Forecast vs actual` table is filled, `## Lessons` has at least one entry with a suggested ingrain target.
5. **Confirm the supervisor's own R1 re-run + retrospective sanity check** happens after the auditor (per the updated `/implement-issue-fix` skill).
6. **Confirm the cold-start property** — open a new Claude Code session, run `/audit-fix packages/twenty-mcp/plans/issue-1-...md` directly. The auditor should be discoverable and runnable without conversation context.
7. **Confirm the closer no longer writes retrospectives** — read the updated `issue-closer.md` agent file and verify the "Retrospective document" section was replaced with "Fill pending fields in existing retrospective." The closer's `tools` list should still include `Edit` (to fill commit SHA) but its allowed targets are documented as retrospective files only.
8. **Confirm the archival files exist** — `plans/2026-05-02-issue-triage-agent-system.md` and `plans/2026-05-02-audit-pipeline.md` both present at repo root, both byte-for-byte matching the source plans (previous-from-conversation-history, current-from-`/root/.claude/plans/`). `plans/README.md` exists with the convention block + 2-row initial index. `git status` should show all three as untracked, ready for the user to `git add plans/`.

If steps 1–8 work, the system is exercised, not just implemented (R1 satisfied for the audit infra itself).

---

## 10. Out of scope (deliberate)

- **CI integration** — the audit is a Claude Code-side step, not a GitHub Action. A future enhancement could mirror the auditor's mechanical gates (typecheck, lint, full suite) into a CI workflow as defence-in-depth.
- **Auditor self-test against a known-buggy diff** — building a synthetic broken diff to verify the auditor catches it. Useful but adds scope; defer.
- **Multiple auditor runs (e.g. one focused on security, one on performance)** — single auditor with a comprehensive checklist is enough for now. Specialization is a v2 question if the single auditor's reports get noisy.
- **Auditor caching / incremental re-runs** — every audit reads from scratch. Fine at this scale; revisit if the audit step becomes a bottleneck.
- **Auto-revising plans based on audit findings** — the auditor reports, the supervisor routes, the triager revises. No agent rewrites a plan based on audit output autonomously; that loop is too easy to spiral.
- **Auto-ingrain of lessons into CLAUDE.md** — the retrospective proposes ingrain targets per lesson; an agent does NOT auto-edit the target CLAUDE.md. Manual gesture by user/supervisor for now. A future enhancement: after the closer finishes, optionally schedule a "draft a CLAUDE.md ingrain PR" agent — but only on user opt-in per close.
