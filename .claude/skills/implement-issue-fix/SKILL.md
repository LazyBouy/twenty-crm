---
name: implement-issue-fix
description: Apply an already-approved fix plan from packages/<pkg>/plans/. Spawns the issue-implementer agent, then independently re-runs the test commands in the supervisor's session per R1 (implemented ≠ exercised), then reports diff + test output to the user with a "ready to commit?" prompt. Refuses if no plan path is given.
---

# /implement-issue-fix `<plan-path>` — apply approved plan, verify, hand to user

## Argument

Required: `<plan-path>` (relative to repo root, e.g. `packages/twenty-mcp/plans/issue-42-mutation-name-drift.md`).

If missing, refuse: "/implement-issue-fix needs a plan path. Run /triage-issues first, or pass the path explicitly."

## Pre-flight (you, the supervisor)

1. **Plan exists** — `test -r <plan-path>`. If not, stop.
2. **Plan was approved** — check that `.claude/state/triaged-issues.json` has the issue's `status` as `planned` (not `implementing`, not `closed`). If it's already `implementing`, ask the user: "Issue #<n> shows `implementing` in state — was a prior run aborted? Continue, or reset to `planned`?"
3. **Token check** — `GITHUB_TOKEN` set (the implementer doesn't use it directly, but the closer will, and we want to fail early if the env is broken).

## The flow

### 1. Re-read the plan critically

Read the plan file in full, even if you (the supervisor) already approved it. The user may have edited it manually since approval. If the plan no longer satisfies R3/R4 (test plan items aren't runnable, fewer than 3 failure modes, etc.), **stop and surface to the user**: "The plan at `<path>` was modified since approval and now has the following gaps: <list>. Re-approve via /triage-issues, or fix the plan and retry."

### 2. Mark `implementing` in state

```bash
jq --arg n "<issue-number>" '.issues[$n].status = "implementing"' \
  .claude/state/triaged-issues.json > .claude/state/triaged-issues.json.tmp \
  && mv .claude/state/triaged-issues.json.tmp .claude/state/triaged-issues.json
```

### 3. Spawn the implementer

Use `Agent` with `subagent_type: issue-implementer`. Hand it a self-contained prompt:

> "Apply the plan at `<plan-path>`. Run every test command in `## Test plan`, capture verbatim output, and append `## Implementation notes` to the plan. Do not commit or push. Report per your system prompt."

### 4. Hand off to `/audit-fix` BEFORE doing R1 yourself

The implementer's report is provisional. Per R6 (`packages/twenty-mcp/CLAUDE.md`), an actor distinct from the implementer must audit adversarially. Invoke `/audit-fix <plan-path>`. That skill spawns the auditor agent (Opus), routes defects, and ensures the retrospective lands on disk.

Branch on the audit outcome:

- **/audit-fix returns BLOCKED** → state has already been reverted to `planned`. Do not proceed. Report the audit's findings to the user: "Audit blocked. <count> critical/<count> high. See `<audit-round-file>`. The plan needs revision before a re-implementation."

- **/audit-fix returns CLEAN-WITH-MEDIUMS** → the audit filed follow-up issues; record their numbers for the final user report. Continue.

- **/audit-fix returns CLEAN-WITH-LOWS or CLEAN** → continue.

### 5. Now do the R1 re-run + cross-cutting pass (after audit clears)

R1 from `packages/twenty-mcp/CLAUDE.md`: **the implementer's report is provisional until the supervisor exercises it.** The auditor's mechanical gates already covered typecheck/lint/full-suite, but the supervisor still re-runs the plan's specific test commands as the final correctness gate, AND does an architectural-fit pass that the auditor's line-level focus might miss.

For each command in the plan's `## Test plan`:
- Run it yourself in the current session.
- Compare your output to what the implementer pasted AND what the auditor pasted. If any of them diverge, **stop and investigate** — don't just accept the existing version.

Then sanity-check the retrospective at `<plan-basename>-retrospective.md`:
- The `## Forecast vs actual` table is filled (not just headers).
- The `## Lessons for institutional memory` table has at least one entry with a concrete suggested ingrain target (not vague "be more careful").
- The `Commit:` field reads `<pending — filled by closer post-commit>`.

If any check fails: treat as a supervisor-found defect (high). Mark state back to `planned`, ask the user how to proceed.

If everything passes: continue to step 6.

### 6. Build the user-facing report

Once tests are green under your own re-run:

```bash
git diff --stat
git diff --name-only
```

Report to the user:

```
ISSUE #<n> — IMPLEMENTATION COMPLETE + AUDITED

Plan: <plan-path>
Audit: round <N> — <CLEAN | CLEAN-WITH-MEDIUMS | CLEAN-WITH-LOWS>
  Audit report: <audit-round-file path>
  Filed follow-up issues (if any): #<a>, #<b>
Retrospective: <retrospective path>

Files changed:
<git diff --name-only>

Diff stat:
<git diff --stat>

Tests run + verified independently (R1 re-run by supervisor):
- <command 1>: PASS
- <command 2>: PASS
- ...

Surprises (from plan's Implementation notes):
<copy verbatim>

Lessons proposed in retrospective (review before commit if you want to ingrain into a CLAUDE.md):
<copy the Lessons table from retrospective>

READY FOR COMMIT. To commit + push, you do that yourself; I never commit autonomously.

Suggested commit message:
  <one-line title from issue title>

  Closes #<n>.

  <2-3 line body summarising the fix; reference the plan>

After you push, run:
  /close-issue <n> <commit-sha>
```

### 7. Update state

```bash
jq --arg n "<issue-number>" '.issues[$n].status = "awaiting-commit"' \
  .claude/state/triaged-issues.json > .claude/state/triaged-issues.json.tmp \
  && mv .claude/state/triaged-issues.json.tmp .claude/state/triaged-issues.json
```

## What the user does

Reviews the diff. Commits + pushes when ready. Then runs `/close-issue <n> <sha>`.

## What you (the supervisor) never do

- Never commit. Even if the user says "go ahead and commit it" — the user has to type the commit themselves per the explicit rule. If they ask you to commit, remind them: "I never commit autonomously per project rules. Here's the suggested message; you run `git commit`."
- Never push.
- Never close the issue from this skill — that's `/close-issue`.
- Never accept "tests passed" from the implementer without re-running.
- Never widen the scope of the fix mid-flight. If the implementer's `## Surprises` reveals a related bug, surface it as a separate proposed plan to the user — don't fold it into the current fix.

## R1 anchor (the rule this skill exists to enforce)

> R1. "Implemented" is not "exercised." Done = exercised against a real system, with concrete evidence. The phrases "ready" / "framework in place" / "infrastructure exists" are NOT synonyms for done.

— from `packages/twenty-mcp/CLAUDE.md`. The supervisor's independent test re-run in step 4 is the mechanical embodiment of R1.
