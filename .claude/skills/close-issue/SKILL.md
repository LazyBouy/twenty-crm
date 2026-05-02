---
name: close-issue
description: After the user has committed and pushed the fix, verify the commit is real and pushed, spawn the issue-closer agent to write a retrospective and post a closing comment, then confirm the GitHub issue is closed. Refuses without both <issue-number> and <commit-sha>.
---

# /close-issue `<issue-number> <commit-sha>` — finalize after the user's push

## Arguments

Both required:
- `<issue-number>` — the GitHub issue number (no `#`).
- `<commit-sha>` — the full or short SHA of the commit that resolves the issue. Use whatever `git push` printed.

If either is missing, refuse: "/close-issue needs both an issue number and a commit SHA. Format: /close-issue 42 abc1234."

## Pre-flight (you, the supervisor)

This is the last gate before the issue closes. Be paranoid.

1. **Token check** — `GITHUB_TOKEN` set. If not, stop.
2. **Commit exists locally** — `git show --quiet <commit-sha>` exits 0. If not, stop: "Commit not found locally — did you mean a different SHA?"
3. **Commit is pushed** — `git branch -r --contains <commit-sha>` returns at least one remote branch. If empty, stop: "Commit isn't on any remote branch yet. Push first, then re-run." Do not let the closer fire on an unpushed SHA.
4. **State file lookup** — `jq -r '.issues["<n>"].planPath' .claude/state/triaged-issues.json` returns a path. If `null` or missing, stop: "Issue #<n> isn't recorded in `.claude/state/triaged-issues.json`. Was it triaged through this system? If not, the closer can't find the plan and will refuse."
5. **State indicates awaiting-commit** — confirm `status` is `awaiting-commit`. If it's already `closed`, stop with: "Issue #<n> already marked closed in state — re-running could double-post the comment. Confirm before proceeding."

If any pre-flight fails, surface the exact failure to the user and stop.

## The flow

### 1. Spawn the closer

Use `Agent` with `subagent_type: issue-closer`. Hand it a self-contained prompt:

> "Close issue #<n> against commit `<full-sha>`. Read the plan at the path recorded in `.claude/state/triaged-issues.json`, write the retrospective next to it, post the closing comment, close the issue via REST, and update state. Report per your system prompt."

### 2. Verify the close worked

After the closer reports back:

- Confirm the API responses it includes (comment URL, `state: closed`).
- Independently re-fetch the issue to be sure:
  ```bash
  curl -sH "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/LazyBouy/twenty-crm/issues/<n>" \
    | jq '{state, state_reason, html_url}'
  ```
  Expect `{"state": "closed", "state_reason": "completed"}`. If not, stop and surface — the closer's report is wrong.
- Check the retrospective file exists at the path the closer named.
- Check the state file shows `status: closed` and the SHA recorded.

### 3. Final report to the user

```
ISSUE #<n> CLOSED

Comment: <html_url of the comment from the API response>
Retrospective: <relative path>
State file: updated to closed.

Grouped issues also closed: #<n2>, #<n3>  (if any)
```

If pre-flight or verification failed at any step, the report explains which step and what's needed to fix it. Don't make the user dig.

## What you (the supervisor) never do

- Never close an issue without re-fetching to verify after the closer's PATCH call. The closer might claim success on a 4xx response if the JSON parsing path is brittle.
- Never let the closer skip the retrospective. If the closer reports "no implementation notes in plan, retrospective not written," stop and tell the user — that means an upstream gate failed (the implementer didn't append notes).
- Never auto-edit `packages/twenty-mcp/CLAUDE.md` (or any other CLAUDE.md) based on the retrospective's "Lessons" section. The closer surfaces them; the user decides whether to wire them in.
- Never run this skill twice for the same issue. The state file is the source of truth — once `closed`, refuse re-runs.

## What the user does

Reads the closing comment on GitHub if they want to verify it. Optionally reviews the retrospective for "Lessons (recommended additions to a CLAUDE.md)." That's it.
