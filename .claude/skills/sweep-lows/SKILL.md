---
name: sweep-lows
description: Scan packages/<pkg>/plans/low-backlog.md files for accumulated foot-gun + cosmetic LOW findings. When a package's Queued count crosses the threshold (default 5), file a single batched GitHub issue containing all queued items and move them to the backlog's Swept (history) section. The standard /triage-issues pipeline then picks up the sweep issue and produces a "low-sweep" plan with one subsection per item. Manual override --force sweeps at any count.
---

# /sweep-lows `[--package <name>] [--force]` — batch the LOW backlog into a fix issue

This skill exists because `/audit-fix` routes `foot-gun` and `cosmetic` LOWs to per-package backlog files (`packages/<pkg>/plans/low-backlog.md`) rather than discarding them or filing one issue per item. When enough accumulate, this skill batches them into a single GitHub issue that runs through the standard fix pipeline. Nothing is annotate-and-forget.

## Arguments

Both optional:
- `--package <name>` — restrict the sweep to one package (e.g. `twenty-mcp`). Default: scan all packages with a `low-backlog.md`.
- `--force` — sweep even if the threshold isn't met. Useful when you want to clear the backlog manually before a milestone or when the queued items have aged enough that batching is worthwhile.

## Threshold

Default: **5 queued items per package**. Below 5, the skill exits with a per-package count summary. At or above 5, the skill files a sweep issue for that package.

`--force` overrides — sweep at any count. If a package's Queued table is empty, even `--force` skips it (no items, no sweep).

If we ever want auto-sweep on a cron, that's an additive change (a `/schedule` registration calling `/sweep-lows`); not in v1.

## Pre-flight (you, the supervisor)

1. **Token check** — confirm `GITHUB_TOKEN` is set. If not, stop.
2. **Lock check** — `test -f .claude/state/triage.lock`. If a fix or triage is mid-flight, no-op with `fix in progress; skipping sweep` log line. Otherwise create the lock with `echo "$(date -Iseconds) sweep" > .claude/state/triage.lock` and `trap 'rm -f .claude/state/triage.lock' EXIT` semantics.
3. **Dirty-tree check** — `git status --porcelain` should be empty (or only contain `.claude/state/` changes). If the user has uncommitted work, log a warning but proceed; this skill only edits the backlog file and the GitHub remote.

## The flow

### 1. Discover backlogs

```bash
# all packages with a backlog file
find packages -path '*/plans/low-backlog.md' -type f
```

If `--package <name>` was passed, restrict to `packages/<name>/plans/low-backlog.md`. If that file doesn't exist, exit: "no backlog for <name>; nothing to sweep."

### 2. Count queued entries per package

For each backlog file, parse the `## Queued` section's table. Count rows (skip header + separator). Build a map `{<pkg>: <count>}`.

### 3. Threshold check

For each package:
- If `count == 0`: skip silently.
- If `count < 5` and not `--force`: skip with a log line: `<pkg>: <n> queued (under threshold)`.
- If `count >= 5` OR `--force`: this package will be swept.

If no packages are eligible to sweep, exit with a consolidated report:

```
SWEEP RUN <ISO> — no sweep needed.

Backlog counts:
- twenty-mcp: 2 (under threshold 5)
- twenty-front: 0
```

### 4. For each eligible package, build and file the sweep issue

**Issue title:** `[<pkg>] Low-priority audit findings sweep — <count> items (<earliest-date>..<latest-date>)`

**Issue body** (rendered via `jq -Rs` to escape JSON):

```markdown
This issue batches <count> low-priority findings from prior `/audit-fix` runs that the policy classified as `foot-gun` or `cosmetic`. Each row links to the source audit-round file. Per the LOW-handling policy ratified on 2026-05-02 (see `plans/2026-05-02-low-handling-policy.md`), these are now batched into a single GitHub issue so they enter the standard `/triage-issues → /implement-issue-fix → /audit-fix → /close-issue` pipeline.

The triager will produce a plan named `packages/<pkg>/plans/issue-<this-issue-number>-low-sweep.md` with one subsection per item.

## Items

| # | Added | Subcategory | Source audit | Description | Suggested resolution |
|---|---|---|---|---|---|
| 1 | <date> | <subcat> | <link> | <description> | <resolution> |
| 2 | … | … | … | … | … |

Source: `/sweep-lows` skill. Filed automatically when the backlog crossed the threshold (5).
```

**Mass-sweep safeguard:** if a single sweep issue would contain **>20 items** in a package, pause and surface to the user before filing — that's a sign the threshold is too high or the backlog has overflowed; the user should approve before filing a 20+ item batch.

POST the issue via REST:

```bash
curl -sX POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/LazyBouy/twenty-crm/issues" \
  -d "$(jq -n --arg title "$TITLE" --arg body "$BODY" '{title: $title, body: $body}')"
```

Capture the returned `number` (the new issue's number).

### 5. Update the backlog atomically

For each item swept:
- Move the row from the `## Queued` table to the `## Swept (history)` table.
- The `Swept on` column = today's ISO date.
- The `Sweep issue` column = `#<n>` (the new issue number).
- The `Plan path` and `Closed in` columns are filled later by the standard pipeline (left blank for now).

Use `Edit` on the backlog file. After the move, the `Queued` table for this package is empty (or contains only items above the >20 mass-sweep cap that were deferred).

### 6. Recommend triage

Tell the user the sweep issue was filed and recommend the next step:

```
Sweep issue #<n> filed for <pkg> (<count> items batched).
Run /triage-issues to pick it up immediately, OR let the daily cron handle it tomorrow.
```

The `/triage-issues` skill (and the daily cron) will then pick up the new issue. The `issue-triager` agent recognizes the sweep title prefix and produces a low-sweep plan per its system prompt's sweep-handling section.

### 7. Final report

```
SWEEP RUN <ISO timestamp>

ISSUES FILED:
- #<n>: [twenty-mcp] Low-priority audit findings sweep — <count> items (<dates>)

BACKLOG UPDATES:
- packages/twenty-mcp/plans/low-backlog.md: <count> items moved Queued → Swept (history)

NEXT: run /triage-issues to start the fix cycle, or wait for the daily 09:00 cron.
```

## What the user does

Reviews the new issue on GitHub if they want. Otherwise nothing — the standard pipeline takes over from `/triage-issues` onward.

## What you (the supervisor) never do here

- Never delete backlog rows. Always MOVE Queued → Swept (history). The history is the institutional record of what was swept and when.
- Never sweep without filing an issue. The whole point is putting the batch into the visible pipeline; in-place fixes belong in `/audit-fix` (trivial-in-place absorption), not here.
- Never auto-fire `/triage-issues` from this skill. The user (or the daily cron) decides when to triage.
- Never skip the mass-sweep safeguard (>20 items requires user confirmation).
- Never edit any source code or test file from this skill. Only the backlog file and the GitHub remote.

## When this skill runs

- **On demand**: when the user types `/sweep-lows` (with or without args) — typical use is when `/audit-fix` surfaces a "Backlog at <n> items in <pkg>; recommend running /sweep-lows" hint in a ready-for-commit report.
- **Manually before a milestone**: `--force` to clear backlog before a release or before stepping away from the project.
- **Future**: a `/schedule` cron registration could fire `/sweep-lows` weekly. Out of scope for v1; the threshold-recommendation surface in `/audit-fix` already gives enough nudge.

## Anchor

The policy this skill enforces: **every LOW finding goes somewhere actionable, including `foot-gun` and `cosmetic`.** The path for those two is: backlog → threshold → batch issue → standard fix pipeline → closed. See `plans/2026-05-02-low-handling-policy.md` for the full rationale.
