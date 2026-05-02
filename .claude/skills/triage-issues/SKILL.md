---
name: triage-issues
description: Discover open/reopened GitHub issues on LazyBouy/twenty-crm, group them, write fix plans to packages/<pkg>/plans/, supervisor approves each plan, then automatically chain into /implement-issue-fix for each approved plan in severity order. Run on the daily 09:00 cron and on-demand. The user only sees a final commit-ready report.
---

# /triage-issues — issue discovery + plan + auto-chain to implement

## When this fires

- **Daily 09:00 local** via the registered routine `twenty-crm-issue-triage-daily`.
- **On-demand** when the user (or you) types `/triage-issues`.

The optional flag `--since <iso-date>` overrides the "since last run" cutoff. Without it, the agent reads `.claude/state/triaged-issues.json → lastTriageRunAt`.

## Pre-flight (you, the supervisor, run these)

1. **Token check** — confirm `GITHUB_TOKEN` is set in the env. If not, stop and tell the user: "GITHUB_TOKEN missing from `.claude/settings.local.json`. Add it before running this skill." Don't try to call the API without it.
2. **Lock check** — `test -f .claude/state/triage.lock` and if present, read it. If a fix is mid-flight (the lock contains an issue number + status), no-op with a "fix in progress on #<n>; skipping triage" log line. Otherwise create the lock with `echo "$(date -Iseconds) triage" > .claude/state/triage.lock` and `trap 'rm -f .claude/state/triage.lock' EXIT` semantics — i.e. always remove it on exit.
3. **Dirty-tree check** — `git status --porcelain` should be empty (or only contain `.claude/state/` changes from a prior run). If the user has uncommitted work elsewhere, log a warning but still proceed — the implementer's pre-flight will refuse to clobber files anyway.

## The flow

### 1. Spawn the triager

Use `Agent` with `subagent_type: issue-triager`. Hand it a self-contained prompt:

> "Run a triage pass against `LazyBouy/twenty-crm`. Read `.claude/state/triaged-issues.json` for the cutoff. Write at most 5 plans. Return your structured report per your system prompt."

(If the user passed `--since`, include "Use `<iso-date>` as the since cutoff instead of the state file." in the prompt.)

### 2. Approve each plan critically (this is the non-delegatable part)

For each plan the triager wrote:

- **Read the full plan file.** Don't trust the agent's summary.
- **Reject and return to triager** if any of these are true:
  - The `Test plan` checklist contains a non-runnable item ("ensure tests pass", "verify behaviour"). R4 violation.
  - Fewer than 3 entries under `Failure modes named`, or any entry lacks a concrete mitigation. R3 violation.
  - The `Root cause hypothesis` has no `file:line` references AND severity is `high`/`critical`. R1 violation — high-severity fixes need ground-truth grounding.
  - The `Proposed fix` is shaped like "improve X" / "refactor Y" / "add error handling" without naming the exact change.
  - The plan touches files outside the package its `> Package:` line claims.
- **Return-to-triager prompt** — when rejecting, send the triager a follow-up via `Agent` with `subagent_type: issue-triager`, naming the plan path and the specific section that failed and why.
- **Approve inline** when the plan passes — no user gate; this is your call.

### 3. Auto-chain to `/implement-issue-fix` THEN `/audit-fix`

For each approved plan, in order of severity (`critical` → `high` → `medium` → `low`):

1. Update `.claude/state/triaged-issues.json` to mark `status: implementing` for the issue(s).
2. Invoke `/implement-issue-fix <plan-path>`. That skill spawns the implementer and reports back.
3. If implementer reports failure (test failed, blocked), **stop the chain on this plan** and escalate.
4. If implementer reports success, invoke `/audit-fix <plan-path>`. That skill spawns the auditor (Opus), routes defects by severity, and ensures the retrospective lands on disk.
5. **Branch on `/audit-fix` outcome:**
   - **BLOCKED** (critical/high defects) → state already reverted to `planned` by /audit-fix; the triager should be re-engaged to revise the plan. The supervisor decides: revise + re-run, or skip this plan and move on.
   - **CLEAN-WITH-MEDIUMS / CLEAN-WITH-LOWS / CLEAN** → confirm `<plan>-retrospective.md` exists; if missing, escalate as a system bug. Mark `status: awaiting-commit`.
6. Move to the next plan in severity order.

If `/implement-issue-fix` OR `/audit-fix` halts the cycle on a plan, **stop the chain.** Don't move on to the next plan automatically — the supervisor evaluates whether to revise (back through triager) or skip and continue. Report back to the user.

### 4. Final report to the user

When all approved plans have been implemented (or the chain halted):

```
TRIAGE + IMPLEMENTATION RUN <ISO>

PLANS APPROVED + IMPLEMENTED + AUDITED: <count>
- #42 (severity: high) — packages/twenty-mcp/plans/issue-42-...md
  Tests: 7/7 green. Diff: 3 files, +12/-4.
  Audit: round 1 clean. Retrospective: packages/twenty-mcp/plans/issue-42-...-retrospective.md
  READY FOR COMMIT.
- #51 (severity: medium) — packages/twenty-docker/plans/issue-51-...md
  Tests: 4/4 green. Audit: round 1 clean-with-mediums (filed #57, #58 as follow-ups).
  Retrospective: packages/twenty-docker/plans/issue-51-...-retrospective.md
  READY FOR COMMIT.

PLANS BLOCKED BY AUDIT:
- #48 — round 1: 1 critical (typecheck failure). State reverted to planned. Plan needs revision.

PLANS APPROVED, IMPLEMENTATION FAILED:
- #47 — implementer halted on test failure. See plan's `## Implementation notes — blocked`.

PLANS REJECTED AT TRIAGE (returned to triager):
- #50 — test plan had no mechanical verifier; revised plan pending.

ISSUES SKIPPED:
- #49 (label: question)

NEXT STEP: review the diffs + retrospectives above, then commit + push each. After push, run /close-issue <n> <sha> for each.
```

If there's nothing to report (no new actionable issues), say exactly:

```
TRIAGE RUN <ISO>: no new actionable issues since <cutoff>.
```

## What the user does

Exactly one thing per ready-to-commit plan: **review the diff, decide whether to commit + push.** That's it. No plan-approval question lands on them. They retain full visibility — they can read any plan in `packages/<pkg>/plans/` at any time and override anything — but the workflow doesn't block on them.

## What you (the supervisor) never do here

- Never commit. The user owns the commit gate.
- Never spawn the closer agent here. That happens via `/close-issue` after the user pushes.
- Never edit a plan yourself — always loop back through the triager. The plan provenance stays clean.
- Never bypass a failed implementer test by accepting "it's probably fine." Per R1: implemented ≠ exercised, and per the user's quality-over-speed mandate, a red test is a hard stop.

## R1–R5 anchor

The full evaluation rules live at `packages/twenty-mcp/CLAUDE.md`. Reread them whenever a plan smells off:

- R1: implemented ≠ exercised
- R2: every deferral names a worst-case bug class
- R3: adversarial pre-mortem before declaring done
- R4: every assertion has a mechanical verifier
- R5: trivial-because-mechanical is a flawed framing
