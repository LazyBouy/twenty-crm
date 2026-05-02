# Plan: GitHub-issue triage + fix workflow with project-scoped subagents

## Context

Bugs in `twenty-mcp` (and adjacent packages) keep surfacing after the fact, because there is no structured loop between **issue discovery** and **fix verification**. The user wants a recurring + on-demand process where dedicated subagents do the legwork (discovery, grouping, planning, fix application, closing) under Claude Code's supervision, and the user only handles two gates: **plan approval** and **commit/push**.

Goal: a project-scoped agent system that:

1. Pulls open/reopened issues from `LazyBouy/twenty-crm` daily + on-demand.
2. Groups related issues into problem statements.
3. Writes a **mandatory** fix plan to the appropriate `packages/<pkg>/plans/` folder (or top-level `plans/` for cross-package).
4. **Supervisor (me) reviews and approves the plan** — the user is not gated here; they retain full visibility (can read any plan, can override) but the workflow doesn't block on them.
5. Agent applies the fix.
6. **Supervisor (me) runs the tests independently** per `packages/twenty-mcp/CLAUDE.md` R1–R5 rules. Tests must actually pass — no exceptions.
7. **User gate (the only one)**: supervisor reports diff + test output. **User decides whether to commit and push.** Supervisor never commits autonomously.
8. After the user's commit, agent closes the issue with a detailed comment + writes the retrospective.

So the human-in-loop reduces from "approve plan → approve commit" to **one gate: approve commit**. The supervisor owns plan approval and test verification.

User decisions captured (already answered):
- Repo: **`LazyBouy/twenty-crm`** (the fork; `origin` already).
- Cadence: **daily 09:00 local + on-demand**.
- Token: **`GITHUB_TOKEN` env var in `.claude/settings.local.json`** (gitignored; one fine-scoped PAT, `repo` or `issues:rw`).
- Retrospective: **after fix, written by the closer agent**.

---

## Architecture overview

```
                 daily cron (09:00 local)        on-demand: /triage-issues
                          │                              │
                          ▼                              ▼
                  ┌──────────────────┐ spawns  ┌──────────────────────┐
                  │ scheduled wakeup │ ──────► │  issue-triager agent │  read issues, group,
                  └──────────────────┘         │      (Sonnet 4.6)    │  write plan to plans/
                                               └──────────┬───────────┘
                                                          │ plan path(s)
                                                          ▼
                                               ┌──────────────────────┐
                                               │  CLAUDE  (supervisor)│  reviews plan critically,
                                               │     — me, Opus 4.7   │  approves OR returns to
                                               │                      │  triager with revisions
                                               └──────────┬───────────┘
                                                          │ supervisor approves (no user gate)
                                                          ▼
                                               ┌──────────────────────┐
                                               │ issue-implementer    │  apply fix, run tests
                                               │   agent (Sonnet 4.6) │
                                               └──────────┬───────────┘
                                                          │ diff + test output
                                                          ▼
                                               ┌──────────────────────┐
                                               │  CLAUDE  (supervisor)│  R1: independently re-runs
                                               │     — me, Opus 4.7   │  tests; rejects if any fail
                                               └──────────┬───────────┘
                                                          │ tests green; report to user
                                                          ▼
                                          ┌─────────  USER GATE  ─────────┐
                                          │  reviews diff + test output;   │
                                          │  commits + pushes (or vetoes)  │
                                          └──────────┬─────────────────────┘
                                                     │ commit SHA
                                                     ▼
                                          ┌──────────────────────┐
                                          │  issue-closer agent  │  write retrospective,
                                          │     (Haiku 4.5)      │  comment + close issue
                                          └──────────────────────┘
```

The supervisor (me) is the only path between agents — agents do not chain themselves. This forces every gate to be an explicit human-in-loop step.

---

## File layout to create

```
.claude/
├── agents/
│   ├── issue-triager.md
│   ├── issue-implementer.md
│   └── issue-closer.md
├── skills/
│   ├── triage-issues/SKILL.md          ← /triage-issues   (on-demand discovery)
│   ├── implement-issue-fix/SKILL.md    ← /implement-issue-fix <plan-path>
│   └── close-issue/SKILL.md            ← /close-issue <issue-number> <commit-sha>
└── settings.local.json                  ← extended with env.GITHUB_TOKEN

packages/twenty-server/plans/            ← created on first server-side fix
packages/twenty-front/plans/             ← created on first frontend fix
packages/twenty-docker/plans/            ← created on first docker fix
plans/                                    ← created on first cross-package fix (root-level)
```

`packages/twenty-mcp/plans/` already exists and is the model for naming/structure.

---

## Agent specifications

All three agents are **project-scoped** (live in `.claude/agents/`) so they auto-register in every session opened in this repo. None of them ever runs `git commit`, `git push`, or modifies `settings.json`.

### 1. `issue-triager` — Sonnet 4.6

**Frontmatter:**
```yaml
---
name: issue-triager
description: Discovers open/reopened GitHub issues on LazyBouy/twenty-crm, groups related ones into problem statements, identifies the affected package, reads relevant code, and writes a fix plan to the correct packages/<pkg>/plans/ folder. Use proactively on schedule and on-demand via /triage-issues. Never modifies source code.
model: sonnet
tools: Bash, Read, Write, Edit, Grep, Glob, WebFetch
color: blue
---
```

**System-prompt responsibilities:**
- Use `curl -H "Authorization: Bearer $GITHUB_TOKEN"` against `api.github.com/repos/LazyBouy/twenty-crm/issues?state=open` plus a separate query for recently reopened (`?state=closed&sort=updated` then filter on `state_reason: reopened`).
- Maintain a state file `.claude/state/triaged-issues.json` (gitignored) recording `{ issueNumber, lastSeenUpdatedAt, planPath, status }` so daily reruns don't redo work that's already in flight or done.
- Skip non-bug issue types (questions, feature requests) for v1 — log and move on.
- For each new/reopened issue:
  1. Fetch full body + comments via REST.
  2. Decide target package using labels first, then file paths/keywords in body.
  3. Group with sibling issues if the body/title shares a root cause (e.g. "all `getRoles` errors" → one plan).
  4. Read the relevant `CLAUDE.md` (always read `packages/twenty-mcp/CLAUDE.md` for R1–R5), plus the implicated source files.
  5. Write the plan using the **template below** to `packages/<pkg>/plans/issue-<n>-<slug>.md`.
- **Hard prohibition**: must not edit any file outside `plans/` or `.claude/state/`.
- **Reopened issues**: read the prior plan + retrospective (linked from prior closing comment) and write a follow-up plan that explicitly contrasts with "why the prior fix didn't hold."
- Output to supervisor: a structured report with `{ issueNumber, planPath, severity, packageName, groupedWith }` per issue + a list of issues skipped and why.

**Plan template (the agent MUST use this; this is the contract):**
```markdown
# Plan: <short title>

> Issue(s): #<n> [(grouped: #n2, #n3)]
> Package: <packages/twenty-mcp | twenty-docker | … | multi>
> Severity: <critical | high | medium | low>
> Worst-case bug class if deferred: <class name from packages/twenty-mcp/CLAUDE.md "Flawed framings" or new>

## Problem statement
## Reproduction
## Root cause hypothesis
<with file:line references>
## Proposed fix
<concrete; cite files to be edited and the shape of the change>
## Test plan (R4: every assertion has a mechanical verifier)
- [ ] <unit test command + expected outcome>
- [ ] <coverage / contract test command + expected outcome>
- [ ] <integration test command + expected outcome — local docker-compose only if destructive>
- [ ] <manual verification step if any>
## Failure modes named (R3: adversarial pre-mortem)
1. <mode 1, with mitigation>
2. <mode 2, with mitigation>
3. <mode 3, with mitigation>
## Out of scope
<explicit deferrals; each names its worst-case bug class per R2>
## References
- packages/twenty-mcp/CLAUDE.md (architecture + R1–R5)
- prior plan(s): <if reopened or sibling-grouped>
```

### 2. `issue-implementer` — Sonnet 4.6

**Frontmatter:**
```yaml
---
name: issue-implementer
description: Applies an approved fix plan from packages/<pkg>/plans/. Reads the plan, edits the listed files, runs the listed tests, and reports actual test output (never paraphrased). Used via /implement-issue-fix <plan-path>. Never commits, never pushes, never closes issues.
model: sonnet
tools: Read, Write, Edit, Bash, Grep, Glob
color: green
---
```

**System-prompt responsibilities:**
- Take a plan path as input.
- Read the plan; treat the "Proposed fix" + "Test plan" sections as the contract.
- Refuse to start if `git status` is dirty in any path the plan would touch.
- Apply edits per the plan.
- Run **every** test command from the test plan. Capture actual stdout/stderr; do not paraphrase.
- If a test fails: **stop**, report the failure, do not proceed. The supervisor decides whether the plan needs revision.
- **Hard prohibition**: must not run `git commit`, `git push`, `git tag`, `gh pr create`, `gh issue close`, or modify `.gitignore`/CI files unless explicitly listed in the plan.
- Append an `## Implementation notes` section to the plan file with: actual files changed (output of `git diff --name-only`), actual test results (paste output verbatim), surprises encountered.
- Output to supervisor: `{ planPath, filesChanged, testsRun, testsPassed, testsFailed, surprises }`.

### 3. `issue-closer` — Haiku 4.5

**Frontmatter:**
```yaml
---
name: issue-closer
description: After the user has committed and pushed the fix, writes the retrospective document and posts a detailed closing comment on the GitHub issue, then closes it. Used via /close-issue <issue-number> <commit-sha>. Never closes an issue without an explicit commit SHA from the supervisor.
model: haiku
tools: Bash, Read, Write, Edit
color: purple
---
```

**System-prompt responsibilities:**
- Take `issueNumber` and `commitSha` as input. Refuse if either is missing.
- Verify `git show <commitSha>` exists locally and `git branch -r --contains <commitSha>` shows it's pushed. Refuse if not pushed.
- Read the plan referenced in the state file (`.claude/state/triaged-issues.json`) for that issue number.
- Write `<plan-basename>-retrospective.md` next to the plan, containing:
  - Forecast vs actual (compare plan's "Test plan" + "Failure modes" with what actually happened — pull from plan's "Implementation notes" section).
  - What surprised us.
  - Lessons that should be added to a CLAUDE.md (recommend, don't auto-edit).
  - Link to the commit SHA + diff stat.
- Post a closing comment via REST (`POST /repos/LazyBouy/twenty-crm/issues/<n>/comments`) using:
  ```markdown
  Resolved in <commitSha>.

  **Summary**: <1-2 sentences>

  **Files changed**: <list>

  **Tests run**: <list with pass count>

  **Plan**: <relative path>
  **Retrospective**: <relative path>

  Closing per supervisor approval.
  ```
- Close the issue via REST (`PATCH /repos/.../issues/<n>` with `{state: "closed", state_reason: "completed"}`).
- **Hard prohibition**: must not close without a commit SHA from the supervisor; must not modify source code; must not amend commits.

---

## Skills (project-scoped, in `.claude/skills/`)

Each skill is a thin wrapper that the supervisor (me) and the user can both invoke; the cron routine also uses the same entry point.

### `/triage-issues`
- **Args**: optional `--since <iso-date>` to override "since last run."
- **Body**: launches `issue-triager` agent. When it returns:
  - Supervisor **reads each plan critically** and either **approves it inline** (R1, R3, R4 satisfied) or **returns it to the triager with specific revisions** (e.g. "the test plan in §X has no mechanical verifier — rewrite §X with a runnable command"). Loop until approved or abandoned.
  - Once approved, supervisor **automatically chains into `/implement-issue-fix`** for each approved plan in severity order — no user gate here.
  - Supervisor reports to user only when there's something they need to see (commit gate) or nothing to do ("no new issues").

### `/implement-issue-fix`
- **Args**: `<plan-path>` (required). Refuses without it.
- **Body**: (1) re-read the approved plan, (2) launch `issue-implementer`, (3) **independently re-run the same test commands in the supervisor's session** per R1 — do not trust the agent's report, (4) if any test fails: do not proceed, return the plan to the triager for revision, (5) if all green: report diff + test output to user with a clear "ready to commit?" prompt.

### `/close-issue`
- **Args**: `<issue-number> <commit-sha>` (both required).
- **Body**: verify the commit is pushed, launch `issue-closer`, confirm the GitHub issue is closed and the retrospective was written.

---

## Scheduling (daily 09:00 local + on-demand)

Use the existing `/schedule` (CronCreate) primitive to register a routine:

```
cron:   "0 9 * * *"            # daily at 09:00 local time
prompt: "/triage-issues"        # same skill the user invokes manually
name:   "twenty-crm-issue-triage-daily"
```

### Where the schedule lives (and how to see it)

**The cron is stored remotely in Claude Code's scheduling service — NOT in `.claude/` in the repo.** Routines are tied to your Anthropic account, not to the project directory. Tradeoff:
- ✅ Runs even when no terminal is open; portable across machines you log in from.
- ❌ Not version-controlled with the repo. Cloning the repo on a fresh machine doesn't bring the cron with it; you'd re-register it via `/schedule`.

**To view / manage the schedule:**
- Run `/schedule` (with no args) — shows the routines list including `twenty-crm-issue-triage-daily`, last fire time, next fire time, and last status.
- The supervisor can also list them programmatically via the `CronList` tool.
- To pause: `/schedule` UI lets you disable a routine without deleting it.
- To delete: `/schedule` UI or the `CronDelete` tool.

**To make the schedule itself versioned in `.claude/`** (optional, recommended for team work): we'd add a one-page `.claude/schedules.md` file that documents the cron entries that *should* exist for this project. The supervisor checks at session start whether each documented routine is registered, and offers to register missing ones. This is **out of scope for v1** but easy to add later — flagged here so the user knows the option exists.

If a triage run finds nothing actionable, the supervisor reports "no new issues" and exits. No follow-up scheduling needed.

---

## GitHub access

**Token storage**: `.claude/settings.local.json` (Claude Code's conventional gitignored local file). Add an `env` block:

```json
{
  "enabledMcpjsonServers": ["postgres", "playwright", "context7"],
  "env": {
    "GITHUB_TOKEN": "ghp_…"
  }
}
```

**Token scope** (fine-grained PAT, recommended):
- Repository access: `LazyBouy/twenty-crm` only.
- Permissions: `Issues: Read and write`, `Contents: Read-only`, `Metadata: Read-only`. Nothing else.

**Rotation**: documented in agents' system prompts ("if you get 401, tell supervisor; do not retry").

**Why no `gh` CLI**: avoids an install step; keeps each agent's REST calls explicit and auditable in the system prompt.

---

## State file

`.claude/state/triaged-issues.json` (gitignored). Schema:

```json
{
  "lastTriageRunAt": "2026-05-02T09:00:00Z",
  "issues": {
    "42": {
      "lastUpdatedAt": "2026-05-01T18:30:00Z",
      "status": "planned | implementing | awaiting-commit | closed",
      "planPath": "packages/twenty-mcp/plans/issue-42-mutation-name-drift.md",
      "groupedWith": [43, 44],
      "commitSha": "<filled by closer>"
    }
  }
}
```

The triager reads + writes this file. The implementer updates `status`. The closer marks `closed` and records the SHA.

---

## What the supervisor (me) does at each gate

This is the **non-delegatable** part. The user touches the workflow exactly once — at the commit gate.

| Gate | Owner | Action | Anchor |
|---|---|---|---|
| 1. Plan approval | **Supervisor (me)** | Read each plan critically. Reject if test plan isn't mechanical (R4 vibes), failure modes are hand-wavy (R3), or scope is unclear. Loop with the triager until approved or abandoned. **No user gate here.** | R1, R3, R4 |
| 2. Post-implementation test | **Supervisor (me)** | **Independently re-run** the implementer's test commands in my own session. Don't trust the agent's report. Per R1: "implemented ≠ exercised." If any fail, return to triager. | R1 |
| 3. Pre-commit report | **Supervisor → User** | Show user: diff stat, test output, surprises. **User decides** whether to commit. I never commit. | user instruction |
| 4. Pre-close | **Supervisor (me)** | Verify commit SHA is on `origin/<branch>` myself before spawning closer. | quality-over-speed |

This list is encoded in each skill body so it survives a cold-start session.

---

## Things the user did **not** mention but that I'm including (please confirm or veto)

1. **Lock file** to prevent the daily cron from running while a fix is mid-flight (`.claude/state/triage.lock`). If lock present, daily run no-ops with a "fix in progress on issue #N" log line.
2. **Dirty-tree refusal** in implementer (already in agent spec).
3. **Reopened-issue handling**: triager reads prior plan + retrospective before writing a follow-up.
4. **Non-bug issues skipped in v1** (questions / feature requests) — log line only; v2 could post a "needs more info" comment.
5. **Multi-package fixes** routed to a top-level `plans/` folder; the plan enumerates all affected packages.
6. **Top-cap of 5 plans per triage run** to prevent the agent from generating a flood; remaining issues queue for the next run.

---

## Critical files

**To create:**
- `.claude/agents/issue-triager.md`
- `.claude/agents/issue-implementer.md`
- `.claude/agents/issue-closer.md`
- `.claude/skills/triage-issues/SKILL.md`
- `.claude/skills/implement-issue-fix/SKILL.md`
- `.claude/skills/close-issue/SKILL.md`
- `.gitignore` patch: add `.claude/state/` and `.claude/settings.local.json`

**To modify:**
- `.claude/settings.local.json` — add `env.GITHUB_TOKEN` placeholder; user fills in real token (we never write a real token to disk on the user's behalf).

**To read (do not modify):**
- `packages/twenty-mcp/CLAUDE.md` — agent system prompts embed the R1–R5 excerpts.
- `packages/twenty-mcp/plans/audit-and-safeguards.md` — canonical plan format reference.

---

## Existing primitives reused (no new infrastructure invented)

- `packages/twenty-mcp/plans/` naming convention → adapted to `issue-<n>-<slug>.md` + `issue-<n>-<slug>-retrospective.md`.
- The R1–R5 evaluation rules from `packages/twenty-mcp/CLAUDE.md` — embedded by reference in each agent's system prompt rather than duplicated.
- `curl` (system-wide) — no `gh` CLI install needed.
- The harness's `Agent` tool to spawn project-scoped subagents.
- The user-level `/schedule` skill — used to register the daily cron routine.

---

## Verification (test the system end-to-end before relying on it)

After the agents/skills land:

1. **Token sanity** — from a fresh session in this repo: `curl -sH "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/LazyBouy/twenty-crm | jq .full_name` → expect `"LazyBouy/twenty-crm"`. (Confirms the env var loaded from `settings.local.json`.)

2. **File a TEST issue** on `LazyBouy/twenty-crm` titled "TEST: triage system smoke" with a synthetic bug body. Manually invoke `/triage-issues`. Expect:
   - Plan file at `packages/twenty-mcp/plans/issue-<n>-test-triage-system-smoke.md`.
   - State file updated.
   - Supervisor reports back with the plan path.

3. **R3 negative test**: with the synthetic issue (no real bug), manually invoke `/implement-issue-fix <path>`. The implementer should report "no actionable change found" rather than fabricate a fix.

4. **Real-issue end-to-end**: pick a real low-severity issue, walk the full pipeline, and verify each gate. Specifically:
   - Plan is mechanical (test commands listed; R4 satisfied).
   - Implementer halts on test failure (induce a failure to confirm).
   - Closer refuses without a commit SHA (call `/close-issue <n>` with no SHA).
   - Closer refuses on an unpushed SHA (pass a local-only SHA).

5. **Cron sanity**: at 09:00 the next day, verify the routine fires. If not, fall back to on-demand-only and surface the failure.

6. **Cold-start session test**: open a fresh Claude Code session in this repo, type `/triage-issues`, verify the skill is discovered and agents are loadable. (Confirms the "agents must perform equally for any session" requirement.)

If any of 2–6 fail, the system itself has a bug — same R1–R5 rules apply: don't rely on it until **exercised**, not just implemented.

---

## Out of scope (deliberate)

- Non-bug issue handling (questions / feature requests) — v1 skips.
- Auto-PR creation — v1 leaves the diff in the working tree for the user to commit.
- Auto-rotate / refresh of the GitHub PAT — manual.
- Cross-repo issue tracking (upstream `twentyhq/twenty`) — explicitly chosen out.
- Per-agent token separation — single PAT used by all three agents.
- Slack / email notifications on triage findings — none.
