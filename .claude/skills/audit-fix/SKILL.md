---
name: audit-fix
description: Run the post-implementation auditor against a plan whose implementer has already appended ## Implementation notes. Spawns issue-auditor (Opus), reads the resulting audit-round file, severity-routes defects (critical/high block + restart triage; medium → file new GitHub issue; low → routed by subcategory: trivial-in-place absorbed pre-commit, cross-cutting filed as new issue, foot-gun + cosmetic backlogged for /sweep-lows). Confirms the retrospective is on disk on a clean pass. The supervisor's R1 re-run + own-audit pass happens AFTER this skill returns. Refuses without a plan path.
---

# /audit-fix `<plan-path>` — adversarial post-implementation audit gate

This skill exists because R1 says "implemented ≠ exercised" and R6 (added in the audit-pipeline plan) says "an actor different from the implementer must read the diff adversarially before commit." Without this skill, the supervisor's audit step is too thin (we shipped plan #1 without a typecheck, lint, or adjacent-callers check).

## Argument

Required: `<plan-path>` (relative to repo root).

If missing, refuse: "/audit-fix needs a plan path. Pass the path of the plan whose `## Implementation notes` you want audited."

## Pre-flight (you, the supervisor)

1. **Plan exists** — `test -r <plan-path>`. If not, stop.
2. **Plan has `## Implementation notes`** — `grep -q '^## Implementation notes' <plan-path>`. If not, refuse: "no audit possible until the implementer has appended Implementation notes. Run /implement-issue-fix first."
3. **Determine round number** — list `<plan-basename>-audit-round-*.md` files in the plan's folder; the next round is `max(existing) + 1` (or 1 if none).
4. **Cycle limit** — if the next round would be **4 or higher**, refuse: "Plan has had 3 audit cycles with persistent blocking defects. Recommend abandoning this plan and triaging the issue from scratch via /triage-issues."

## The flow

### 1. Spawn the auditor

Use `Agent` with `subagent_type: issue-auditor`. Hand it a self-contained prompt:

> "Audit the plan at `<plan-path>` — round `<N>`. Run all 10 mechanical gates listed in your system prompt. Read every changed source/test file in full. Apply the adversarial reading checklist. Write the structured report to `<plan-basename>-audit-round-<N>.md`. If the round is clean (zero critical, zero high), also write `<plan-basename>-retrospective.md` consolidating all audit-round-*.md files in this plan's series. Return your structured summary per your system prompt."

### 2. Read the audit-round file

After the auditor returns, read `<plan-basename>-audit-round-<N>.md` directly — the auditor's message-level summary is helpful for routing but the file is the source of truth.

### 3. Apply severity routing

Append a one-line annotation to the plan via `Edit`, depending on what the auditor found:

- **Any CRITICAL or HIGH defects** →
  - Append to plan: `> Audit round <N>: BLOCKED — see <audit-round-file-relative-path> (<n_critical> critical, <n_high> high)`.
  - Update `.claude/state/triaged-issues.json` to revert the issue's status from `implementing` to `planned`.
  - Report to user: "Audit blocked the fix. <n_critical>/<n_high> critical/high defects in round <N>. Plan needs revision — re-engage triager via /triage-issues, or fix in place if it's a known one-liner. After revision, re-run /implement-issue-fix and /audit-fix; this counts as round <N+1> (max 3)."
  - **The auditor will NOT have written the retrospective on a blocking pass** — this is correct; do not flag the absence as a system bug.
  - **Stop here.** Do NOT proceed to step 4 or 5. The cycle resumes when the user re-invokes /implement-issue-fix.

- **MEDIUM defects only (no critical, no high)** →
  - For each medium defect, file a new GitHub issue via REST using the auditor's draft title + body. Issue body must include: `Discovered during audit of #<parent>. <auditor's description>. Where: <file:line>. Suggested fix: <auditor's suggestion>. Filed automatically by the audit pipeline. Will be picked up in the next /triage-issues run. Parent issue: #<n>. Audit report: <audit-round-file-relative-path>.`
  - **Confirmation gate**: if there are MORE THAN 3 mediums, pause and ask the user before mass-filing — that's a sign of a structural problem worth surfacing.
  - Append to plan: `> Audit round <N>: medium defects → filed issues #<a>, #<b>; see <audit-round-file-relative-path>`.
  - Confirm the retrospective is on disk (step 4).

- **LOW defects only (no critical, high, or medium)** →
  Group LOWs by subcategory (the auditor must have tagged each: `trivial-in-place | cross-cutting | foot-gun | cosmetic`). Route per subcategory — **nothing is annotate-and-forget**:

  - For each `trivial-in-place` LOW:
    - Apply the auditor's `Suggested action` Edit verbatim.
    - Re-run the affected test pattern + the contract test as a regression check.
    - Append to plan: `> Audit round <N>: LOW absorbed pre-commit (trivial-in-place): <short-desc>`.
  - For each `cross-cutting` LOW:
    - File a new GitHub issue via REST using the auditor's draft title + body. Body must include a marker line: `Source: audit-fix LOW (cross-cutting). Parent issue: #<n>. Audit report: <audit-round-file-relative-path>.`
    - **Mass-cross-cutting safeguard**: if a single round produces >3 cross-cutting LOWs, pause and ask the user before filing — this likely indicates baseline drift, not per-fix defects.
    - Append to plan: `> Audit round <N>: LOW filed as #<n> (cross-cutting): <short-desc>`.
  - For each `foot-gun` or `cosmetic` LOW:
    - Append the entry to `packages/<pkg>/plans/low-backlog.md` `## Queued` table. Create the file with the documented schema if it doesn't exist yet.
    - Append to plan: `> Audit round <N>: LOW backlogged (<subcategory>): <short-desc>`.

  After all LOWs routed, **check the backlog count** for the affected package:
  - If `Queued` count crossed the threshold (default 5), surface a recommendation in the final ready-for-commit report: `Backlog at <n> items in <pkg>; recommend running /sweep-lows to file a batched issue.` (Do NOT auto-fire `/sweep-lows` — that's a user-gated action.)

  Confirm the retrospective is on disk (step 4).

- **No defects at all** →
  - Append to plan: `> Audit round <N>: clean — see <audit-round-file-relative-path>`.
  - Confirm the retrospective is on disk (step 4).

### 4. Retrospective gate (proceed-cases only)

For every non-blocking outcome above:

```bash
test -r '<plan-basename>-retrospective.md' || { echo "RETROSPECTIVE MISSING"; }
```

If the retrospective file is missing, this is a **hard system failure** — the auditor was supposed to write it on a clean pass. Surface to the user: "Auditor returned clean but did not write the retrospective. This is a system bug. Do not proceed to commit. Investigate the auditor's run."

If the retrospective exists, sanity-check:
- The `## Forecast vs actual` table is filled (not just headers).
- The `## Lessons for institutional memory` table has at least one entry (or explicitly says "no lessons applicable" with a reason).
- The `Commit:` field reads `<pending — filled by closer post-commit>` (the closer fills this later).

If any of these fail, treat them as supervisor-found defects (high severity) — block the cycle, ask the user to re-spawn the auditor.

### 5. Hand off

Final message back from this skill (to the supervisor's main flow):

```
AUDIT-FIX RUN <ISO timestamp>

PLAN: <plan-path>
ROUND: <N>
OUTCOME: BLOCKED | CLEAN-WITH-MEDIUMS | CLEAN-WITH-LOWS | CLEAN

AUDIT REPORT: <audit-round-file path>
RETROSPECTIVE: <retrospective path>  (omitted if BLOCKED)
DEFECTS ROUTED:
  - blocking: <n_critical + n_high>
  - filed as new issues: <list of issue numbers>
  - annotated to plan: <count>

NEXT: supervisor R1 re-run + own-audit pass + retrospective sanity check (per /implement-issue-fix step 4).
```

After this skill returns, the supervisor (the main session) takes over for the R1 re-run and the architectural pass per the updated `/implement-issue-fix` skill body.

## What the user does

Nothing during /audit-fix. The skill is fully agent-driven; the user only sees the final structured outcome.

## What you (the supervisor) never do here

- Never edit the audit-round file after the auditor writes it. It's frozen historical record.
- Never write or edit the retrospective yourself — that's the auditor's job. If the retrospective is missing or malformed, escalate; don't fix it in place.
- Never ship past a critical/high finding without an explicit user override. R6 has zero exceptions.
- Never auto-file medium issues if there are more than 3 in a single round — pause and ask first.
- Never invoke /audit-fix on a plan whose Implementation notes section is missing — that's the implementer's responsibility, surface it.

## R6 anchor (the rule this skill exists to enforce)

> R6. Post-implementation adversarial audit, by an actor distinct from the implementer.

— see `packages/twenty-mcp/CLAUDE.md`. The auditor's distinct-actor property + the supervisor's downstream R1 re-run + own-audit pass are the two-level enforcement of R6.
