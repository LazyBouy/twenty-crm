---
name: audit-permissions
description: Run the permissions-auditor agent over a time window; produces a markdown report at .claude/state/permissions-audit-<ISO>.md.
---

# /audit-permissions `[start_ts] [end_ts]` — on-demand permission telemetry audit

This skill is the entry point for periodically reviewing the twenty-crm permission system's telemetry. It spawns the `permissions-auditor` agent (sonnet), which reads `.claude/tool-use.log` + `.claude/settings.json` and writes a structured report to `.claude/state/permissions-audit-<ISO>.md`.

The user then reviews §H ("proposed standards updates") and decides which to apply by hand-editing `.claude/settings.json`.

## Arguments

Both optional:
- `<start_ts>` — ISO-8601 timestamp (e.g. `2026-05-12T00:00:00Z`). Default: end_ts of the most-recent prior audit (or "7 days ago" if no prior audit).
- `<end_ts>` — ISO-8601 timestamp. Default: now (UTC).

If only `<start_ts>` is provided, `<end_ts>` defaults to now.

## Pre-flight (you, the supervisor)

1. **Telemetry log exists** — `test -f .claude/tool-use.log`. If not, stop with: "telemetry log not yet created. Run any agent / tool through the harness once to fire the PostToolUse hook, then re-run /audit-permissions."
2. **Settings policy exists** — `test -f .claude/settings.json`. If not, stop with: "no .claude/settings.json found. The audit cross-references rules against the live log; without a policy file there's nothing to audit."
3. **State directory writable** — `test -d .claude/state || mkdir -p .claude/state`.
4. **No mid-flight audit running** — `test ! -f .claude/state/.permissions-audit.lock` (defensive; the agent doesn't currently lock, but reserve the path for future concurrency).

If any pre-flight fails, surface the exact failure to the user and stop.

## The flow

### 1. Spawn the auditor

Use `Agent` with `subagent_type: permissions-auditor`. Hand it a self-contained prompt:

> "Audit the twenty-crm permission system. Window: `<start_ts>` → `<end_ts>` (or use defaults if either arg is empty). Read `.claude/tool-use.log` (current + rotations), cross-reference against `.claude/settings.json` allow/deny rules, classify into §A–§H sections per your system prompt, write the report to `.claude/state/permissions-audit-<ISO>.md`. Return your structured final-message summary."

### 2. Read the report file directly

After the agent returns, **read the report file path it cites** — don't trust the agent's summary alone. Verify:
- The file exists at the claimed path.
- §A (tool distribution) is populated.
- §B (hot allow-rule candidates), §D (allow-rule utilization), §E (hook denials), §H (proposed standards updates) sections are present (may be empty if no findings).

If any section is missing or malformed, treat as a system bug: stop and report. Don't suppress findings.

### 3. Surface top findings to the user

Quote the agent's final-message §H top-3 verbatim. Provide the report path so the user can read the full report.

```
PERMISSIONS AUDIT COMPLETE

Window: <start_ts> → <end_ts>
Events analyzed: <N>
Report: <report-path>

Top 3 proposed updates (§H):
  1. <rule>  — addresses <N> PermissionRequest events
  2. ...
  3. ...

Hot allow-rule candidates (§B): <count>
Hook denials (§E): <count>
Cross-cycle escalations (§G): <count, with regression-tagged signatures if any>

Next: read the report, decide which §H actions to apply. Edit .claude/settings.json directly. Commit + push. Next session inherits the updates.
```

### 4. Optional follow-up

After the user applies §H updates and commits, the **next** audit cycle's §G will automatically detect if any "applied" rule failed to match its target signatures (regression-pattern-failed-validation). The skill doesn't need to track this — the agent handles it via cross-cycle file comparison.

## What the user does

- Reads the report at the path you surfaced.
- Decides which §H actions to apply. Some they'll skip (e.g. a "removal candidate" rule that they remember is for a rare-but-legitimate workflow).
- Hand-edits `.claude/settings.json` to add/remove the chosen rules.
- Commits + pushes if `.claude/settings.json` is git-tracked (which it should be per the plan).
- Restarts their next session — the updated policy applies.

## What you (the supervisor) never do

- **Never edit `.claude/settings.json` from this skill.** Even if §H looks obviously correct, the user reads the full report's context before deciding. Auto-applying would bypass that review.
- **Never close findings.** Audit reports stay on disk as the permanent record of what the policy looked like at each cycle. Don't `rm` them.
- **Never auto-fire this skill.** Per the user's plan decision (Section 8C), the auditor runs on-demand only — not at end-of-`/triage-issues` or end-of-`/close-issue`. If you find yourself wanting to add automatic invocation, surface it as a v2 proposal to the user.
- **Never spawn the auditor on an empty log.** The pre-flight catches this; if you skip pre-flight and spawn anyway, the agent will return a "no telemetry" stub report — wasted tokens.

## R-anchors

- The audit cycle is the institutional-memory mechanism. Each report is a snapshot of what the policy got right (§D rules with hits) and got wrong (§B unmet candidates, §E false-positives). Over time, the directory of audit reports tells the story of the permission policy's evolution.
- R5 ("trivial-because-mechanical") applies here too: editing settings.json IS mechanical, but the consequence of a wrong rule (false-allow letting destructive ops through, or false-deny breaking the workflow) is real. The user reading the full §H before applying is the safeguard.
