# Plan: Claude Code Permission System for twenty-crm

## Context

Twenty-crm currently has no team-shared permission policy: `.claude/settings.local.json` exists with only `GITHUB_TOKEN` + MCP server enables, there is no `.claude/settings.json`, no hooks, and no telemetry. Every session of the 4-agent issue pipeline (`issue-triager`, `issue-implementer`, `issue-auditor`, `issue-closer`) currently runs with Claude Code's defaults — meaning the user gets prompted for routine commands that the pipeline runs many times per cycle (`npx jest`, `npx nx typecheck`, `curl api.github.com`, `docker ps`, `jq`), and there are no machine-enforced guardrails against the destructive operations every agent body verbally prohibits.

The goal: design a comprehensive permission system that (a) eliminates redundant prompts for known-good operations, (b) hard-enforces the existing "agents must never commit/push/restart-infra/modify-env" rules via hooks rather than self-discipline alone, (c) captures every PreToolUse / PostToolUse / PermissionRequest event to a telemetry log, and (d) provides a dedicated `permissions-auditor` agent that reads the telemetry on demand and produces an audit report identifying hot allow-rule candidates, dead rules, hook denials, and proposed policy updates.

**This policy is specifically designed for the twenty-crm project.** It is NOT a generic template: the allow rules cite the actual GitHub repo (`LazyBouy/twenty-crm`), the actual ports (`:4440` Twenty server, `:4441` MCP), the actual workspace package names (`twenty-mcp`, `twenty-server`, `twenty-front`, `twenty-shared`, `twenty-docker`, `twenty-utils`), the actual fixture paths, the actual issue-pipeline agent names, the actual sister `.claude/` memory root (`/root/.claude/projects/-root-projects-fullstack-twenty-crm-twenty-crm/memory/`), the actual MCP servers enabled (`postgres`, `playwright`, `context7`), and the actual capture scripts (`packages/twenty-mcp/scripts/capture-inner-schemas.ts`). The reference at `/root/projects/phi/.claude/` is structural inspiration — its concrete rules don't transfer (phi is a Rust workspace; twenty-crm is a TypeScript Nx monorepo with Docker stack).

User decisions ratified in this planning session: track policy in git, use `acceptEdits` mode (auto-accept Edit/Write/MultiEdit; prompt on Bash not on allow list), run the auditor on-demand only, whitelist GitHub family + npm registry + Docker docs + Twenty docs + Anthropic docs for WebFetch, **move most docker/git mutating commands out of hard-deny so the user can approve them ad-hoc via the prompt** (only truly destructive operations stay in hard-deny).

---

## Recommended approach

A 4-layer permission system that mirrors phi's proven pattern, retuned for twenty-crm:

1. **Base policy** — `.claude/settings.json` with `defaultMode: "acceptEdits"`, explicit allow list, explicit deny list, `additionalDirectories` whitelist.
2. **Defense-in-depth hooks** — 3 shell scripts in `.claude/hooks/`: scope-edits, block-destructive-bash, log-tool-use.
3. **Telemetry log** — `.claude/tool-use.log` (JSONL, gitignored, rotated at 10 MiB / 5 keeps).
4. **Audit cycle** — `permissions-auditor` agent (sonnet) reads log + settings, writes report to `.claude/state/permissions-audit-<ISO>.md`, invoked on-demand via the new `/audit-permissions` skill.

The supervisor (the main session) is the only actor that edits `.claude/settings.json` — no agent has write access. Findings flow: agent writes audit report → user reads it → user edits settings.json → commits → next session inherits.

---

## Section 1 — File / directory layout

| Artifact | Path | Tracked? | Notes |
|---|---|---|---|
| Policy | `.claude/settings.json` | **Yes** (after gitignore change) | Team-shared allow/deny/mode |
| User overrides | `.claude/settings.local.json` | No | Holds `GITHUB_TOKEN` + per-user MCP toggles |
| Hooks | `.claude/hooks/*.sh` | **Yes** (after gitignore change) | scope-edits, block-destructive-bash, log-tool-use |
| Telemetry log | `.claude/tool-use.log[.1..5]`, `.log.lock` | No (always gitignored) | JSONL; can grow |
| Audit reports | `.claude/state/permissions-audit-<ISO>.md` | No (state dir gitignored) | One per audit run |
| Audit agent | `.claude/agents/permissions-auditor.md` | Yes (existing exception) | Sonnet; read+write+grep+glob+bash |
| Audit skill | `.claude/skills/audit-permissions/SKILL.md` | Yes (existing exception) | `/audit-permissions [start_ts] [end_ts]` |
| Design doc | `plans/2026-05-13-claude-permissions-system.md` | Yes | This plan + ratification history |

### Required `.gitignore` change

Current root `.gitignore` lines 6–11 (single source of truth):
```
.claude/*
!.claude/agents/
!.claude/skills/
```

Add two exceptions to except policy + hooks:
```
.claude/*
!.claude/agents/
!.claude/skills/
!.claude/settings.json
!.claude/hooks/
```

`tool-use.log*`, `state/`, `settings.local.json` continue to match the broad `.claude/*` deny — confirmed gitignored.

---

## Section 2 — Permission mode

```json
{ "permissions": { "defaultMode": "acceptEdits" } }
```

`acceptEdits` semantics:
- **Edit / Write / MultiEdit** → auto-accepted (still bounded by the `scope-edits.sh` hook in Section 6A — out-of-roots writes are hard-denied).
- **Bash command on the allow list** → auto-accepted.
- **Bash command on the deny list** → blocked outright (no prompt; deny precedence is highest).
- **Bash command NOT on either list** → **prompts the user** for one-time approval. This is the safety valve.
- **Read** → always allowed (sensitive deny patterns in Section 4H still apply).

Rationale for choosing `acceptEdits` over `dontAsk`: the user explicitly wants the ability to approve some currently-denied docker/git operations ad-hoc (e.g. `docker compose pull`, `git commit -m '…'`, `yarn install` when a plan requires it). `dontAsk` silently rejects anything not on the allow list, eliminating that flexibility. `acceptEdits` keeps file edits fast (agents writing plans/source/state don't trigger prompts) while letting Bash fall through to prompt for ad-hoc approval. The hard-deny list (Section 4) still blocks the truly dangerous things (rm -rf, sudo, kubectl, auto-fixers, sensitive paths) — they never prompt.

To absorb the upfront cost of "comprehensive allow list for routine ops", Sections 3–4 enumerate every command pattern derived from current agent bodies + skill bodies (exploration verified, not speculative). Sections 4A–4D have been **deliberately relaxed** from the phi reference's stricter posture — phi denies all docker/git mutations outright; twenty-crm prompts on them so the supervisor can approve case-by-case.

---

## Section 3 — Allow rule taxonomy

All rules go in `.claude/settings.json` under `permissions.allow`. Order matters only for deny-vs-allow precedence — within `allow`, ordering is for human readability (categories below).

### 3A — Bash: read-only inspection (used by every agent every session)

| Rule | Rationale | Frequency |
|---|---|---|
| `Bash(git status*)` | implementer pre-flight; closer + auditor diff check | every cycle |
| `Bash(git diff*)` | implementer impl-notes; auditor diff read | every audit |
| `Bash(git log*)` | closer SHA verify; auditor history check | every close |
| `Bash(git show*)` | closer verifies commit exists | every close |
| `Bash(git rev-parse*)` | resolve refs | rare |
| `Bash(git branch -r --contains*)` | closer verifies pushed | every close |
| `Bash(git ls-files*)` | auditor file listing | per audit |
| `Bash(git cat-file*)` | auditor blob read | rare |
| `Bash(git fsck*)` | auditor integrity check | rare |
| `Bash(git stash list*)`, `Bash(git stash show*)` | inspect in-flight | rare |
| `Bash(grep*)`, `Bash(find*)`, `Bash(ls*)`, `Bash(cat*)`, `Bash(head*)`, `Bash(tail*)`, `Bash(wc*)`, `Bash(awk*)`, `Bash(sed -n*)`, `Bash(cut*)`, `Bash(sort*)`, `Bash(uniq*)`, `Bash(tr*)`, `Bash(xargs*)`, `Bash(stat*)`, `Bash(diff*)`, `Bash(echo*)` | universal read-only shell verbs | constant |
| `Bash(test -r*)`, `Bash(test -f*)`, `Bash(test -d*)`, `Bash([ -f*)`, `Bash([ -d*)`, `Bash([ -r*)` | pre-flight file existence checks across all skills | every cycle |
| `Bash(jq*)` | state-file reads in triager/closer; JSON parsing throughout | every triage/close |
| `Bash(python3 -c *)` | one-off scripted computations | rare |

**Note on `sed -n` vs `sed`**: only `sed -n` (read-only print mode) allowed; bare `sed` is denied via hook because of `sed -i` risk.

### 3B — Bash: test runners (implementer + auditor)

| Rule | Rationale | Frequency |
|---|---|---|
| `Bash(npx jest*)` | implementer test plan; auditor full-suite gate | every audit |
| `Bash(npx nx typecheck*)` | auditor mechanical gate 1 | every audit |
| `Bash(npx nx lint:diff-with-main*)` | auditor mechanical gate 2 (added by #18) | every audit |
| `Bash(npx nx test*)`, `Bash(npx nx run*)` | nx target invocations | per-plan |
| `Bash(npx prettier --check*)` | linting probe; `--write` denied separately | per-plan |
| `Bash(npx tsx scripts/capture-inner-schemas.ts*)` | named capture script (writes only to fixture path, scope-edits hook validates) | rare, per plan |
| `Bash(npx dotenv -e .env.local --*)` | env-loader prefix for integration tests | rare |

### 3C — Bash: GitHub REST API (triager + closer)

| Rule | Rationale | Frequency |
|---|---|---|
| `Bash(curl -sH Authorization* https://api.github.com/repos/LazyBouy/twenty-crm/*)` | triager issue list/get; closer comment/close | every triage/close |
| `Bash(curl -s -H Authorization* https://api.github.com/repos/LazyBouy/twenty-crm/*)` | spacing variant of above | per-call |
| `Bash(curl -X POST -H Authorization* https://api.github.com/repos/LazyBouy/twenty-crm/issues/*)` | closer posts comment, supervisor files issues | per close |
| `Bash(curl -X PATCH -H Authorization* https://api.github.com/repos/LazyBouy/twenty-crm/issues/*)` | closer closes issue | every close |
| `Bash(curl -sH Authorization* https://api.github.com/user*)` | triager identity check | once per cycle |

URL prefix is locked to `LazyBouy/twenty-crm` and `api.github.com/user`. All other `curl` invocations are blocked by the bash hook (Section 6B item 4) — they don't even prompt; the hook rejects outright.

### 3D — Bash: Docker inspection (implementer + auditor + supervisor)

| Rule | Rationale | Frequency |
|---|---|---|
| `Bash(docker ps*)` | check stack health before tests | per integration |
| `Bash(docker logs*)` | service-state inspection | rare |
| `Bash(docker inspect*)` | service-state inspection | rare |
| `Bash(docker images*)` | image inventory | rare |
| `Bash(docker compose -f packages/twenty-docker/docker-compose.deploy.yml ps*)` | compose project state check | per integration |
| `Bash(docker volume ls*)`, `Bash(docker network ls*)` | inventory only | rare |

Docker mutating verbs (up/down/build/pull/restart/run/push/stop/start/rm/rmi/exec/volume/network) are **prompt-on-use** (Section 4G) — the user approves them ad-hoc. Pipeline agents (issue-*) still self-prohibit them in their bodies; the prompt only ever fires for the main session.

### 3E — Bash: MCP / local-stack healthchecks

| Rule | Rationale | Frequency |
|---|---|---|
| `Bash(curl -sf http://localhost:4440/healthz*)` | Twenty server healthz | per integration |
| `Bash(curl -sf http://localhost:4441/mcp*)` | MCP initialize probe | per integration |
| `Bash(curl -s -X POST http://localhost:4441/mcp*)` | MCP tools/call probes | per integration |
| `Bash(curl -sf http://127.0.0.1:*/healthz)` | generic loopback health | per integration |

Localhost / 127.0.0.1 only. Public network `curl` falls through to deny except the GitHub-API allow-rules in 3C.

### 3F — File ops: Read / Edit / Write / MultiEdit

| Rule | Rationale |
|---|---|
| `Read(/**)` | Unrestricted read across allowed roots — necessary; auditor must read source it doesn't write. Sensitive paths denied separately in Section 4H. |
| `Edit(/root/projects/fullstack/twenty-crm/twenty-crm/**)` | Project tree (paired with `scope-edits.sh` defense-in-depth) |
| `Write(/root/projects/fullstack/twenty-crm/twenty-crm/**)` | Same |
| `MultiEdit(/root/projects/fullstack/twenty-crm/twenty-crm/**)` | Same |
| `Edit(//root/.claude/agents/**)`, `Write(//root/.claude/agents/**)` | Agent definitions (the supervisor's harness updates) |
| `Edit(//root/.claude/skills/**)`, `Write(//root/.claude/skills/**)` | Skill definitions |
| `Edit(//root/.claude/projects/-root-projects-fullstack-twenty-crm-twenty-crm/memory/**)`, `Write(//same)` | Per-project auto-memory |
| `Edit(//root/.claude/plans/**)`, `Write(//root/.claude/plans/**)` | Plan-mode plan files |

The `additionalDirectories` field in settings.json lists the four sister `.claude/` roots so Claude Code knows to allow reads/writes within them.

### 3G — Agent spawning

| Rule | Rationale |
|---|---|
| `Agent(issue-triager)` | Pipeline agent |
| `Agent(issue-implementer)` | Pipeline agent |
| `Agent(issue-auditor)` | Pipeline agent |
| `Agent(issue-closer)` | Pipeline agent |
| `Agent(permissions-auditor)` | New agent introduced by this plan |
| `Agent(Explore)`, `Agent(Plan)`, `Agent(general-purpose)` | First-party harness agents |
| `Agent(claude-code-guide)` | Optional doc-lookup agent |

### 3H — WebFetch

| Rule | Rationale |
|---|---|
| `WebFetch(domain:docs.anthropic.com)`, `WebFetch(domain:code.claude.com)` | Anthropic / Claude docs |
| `WebFetch(domain:github.com)`, `WebFetch(domain:raw.githubusercontent.com)`, `WebFetch(domain:api.github.com)` | GitHub family |
| `WebFetch(domain:registry.npmjs.org)` | Package version research (user-selected) |
| `WebFetch(domain:docs.docker.com)` | Docker docs (user-selected) |
| `WebFetch(domain:twentyhq.github.io)`, `WebFetch(domain:docs.twenty.com)` | Twenty CRM docs (user-selected) |

---

## Section 4 — Deny rule taxonomy

**Two tiers** (the user's revised design):

**Tier 1 — HARD DENY** (Sections 4A–4F): truly destructive operations that should NEVER fire, even via user prompt approval. Listed in `permissions.deny` of `settings.json`. These never reach the prompt — they're auto-rejected.

**Tier 2 — PROMPT-ON-USE** (Section 4G): commands that are sometimes legitimate but require the user's case-by-case approval. These are **NOT** in the deny list and **NOT** in the allow list — they fall through to `acceptEdits` mode's prompt. The supervisor (the user) sees a one-line prompt and approves or denies per-invocation. Pipeline agents (issue-* family) still self-prohibit these in their bodies; the prompt only ever fires for the main session.

The phi reference denies most of Tier 2 outright; twenty-crm relaxes that posture per user request.

Precedence (Claude Code): `deny > hook-deny > allow > defaultMode-prompt`.

### 4A — Destructive shell + privilege (HARD DENY)

`Bash(rm -rf*)`, `Bash(rm -fr*)`, `Bash(rm -Rf*)`, `Bash(rm -r /*)`, `Bash(sudo*)`, `Bash(su *)`, `Bash(su)`, `Bash(chmod -R 777*)`, `Bash(chown -R *)`, `Bash(dd if=*)`, `Bash(dd of=*)`, `Bash(mkfs*)`, `Bash(mkfs.*)`, `Bash(find * -delete*)`

Rationale: recursive forced delete, privilege escalation, disk destruction, broad ownership changes. No legitimate workflow needs these via Claude; if you actually need them, run from a separate shell outside Claude.

### 4B — Auto-fixers (HARD DENY — per implementer + auditor body contracts)

`Bash(npx prettier --write*)`, `Bash(prettier --write*)`, `Bash(npx prettier -w*)`, `Bash(npx eslint --fix*)`, `Bash(eslint --fix*)`, `Bash(npx oxlint --fix*)`, `Bash(npx nx fmt*)`, `Bash(npx nx lint --configuration=fix*)`

Rationale: agents must NEVER auto-fix. The `issue-auditor.md` "Destructive Bash commands — forbidden" section (line 218) explicitly forbids these because of the L13 incident — the auditor used `prettier --write` + `git checkout --` and silently lost the supervisor's in-flight refactor. This is the one class of "format fix" where the user-prompt fallback is NOT safe; even when prompted, the answer should always be no.

### 4C — In-place file mutation that bypasses Edit/Write scope (HARD DENY)

`Bash(sed -i*)`, `Bash(sed --in-place*)`, `Bash(awk -i inplace*)`, `Bash(perl -i*)`, `Bash(perl -i.*)`

Rationale: these forms write to files without going through the Edit/Write tool, which means `scope-edits.sh` doesn't see them. Use `Edit` or `Write` instead.

Note: `tee`, `cp`, `mv` are **NOT** in hard-deny — they have legitimate uses (e.g., `cp .env.example .env` for a fresh dev setup). They fall through to prompt under `acceptEdits`. The bash hook (Section 6B) additionally denies `tee` / `cp` / `mv` that target sensitive paths.

`echo >>`, `cat >`, `printf >>` writing to sensitive paths (credentials, host config, sister `.claude/`) are caught by the bash hook regex (Section 6B items 11–12), not by rules (impossible to match in rule syntax). Redirection writes to non-sensitive paths fall through to the user prompt.

### 4D — Network commands that bypass the GitHub/localhost whitelist (HARD DENY)

`Bash(wget*)`, `Bash(nc *)`, `Bash(nc -*)`, `Bash(ncat*)`, `Bash(ssh *)`, `Bash(scp *)`, `Bash(rsync *)`, `Bash(ftp *)`, `Bash(sftp *)`, `Bash(telnet *)`

Rationale: data exfiltration vectors. `curl` is NOT denied here because we whitelist specific GitHub + localhost URLs in 3C/3E; the bash hook (Section 6B item 4) blocks `curl` to other destinations.

### 4E — Sensitive paths (HARD DENY for Read + Edit + Write + MultiEdit)

`Edit(//root/.ssh/**)`, `Edit(//root/.aws/**)`, `Edit(//root/.gnupg/**)`, `Edit(//root/.netrc)`, `Edit(//root/.npmrc)`, `Edit(//root/.gitconfig)`, `Edit(//etc/**)`, `Edit(//usr/**)`, `Edit(//var/**)`, `Edit(/**/.env)`, `Edit(/**/.env.*)`, `Edit(/**/credentials.json)`, `Edit(/**/secrets.json)`, `Edit(/**/*-credentials.json)`, `Edit(/**/.git/config)`. Same mirrors for `Write(...)` and `MultiEdit(...)`.

Plus Read denies for the truly sensitive (secrets shouldn't even be visible to an agent):
`Read(/**/.env)`, `Read(/**/.env.*)`, `Read(//root/.ssh/**)`, `Read(//root/.aws/**)`, `Read(//root/.gnupg/**)`, `Read(//root/.netrc)`.

Rationale: credentials and host config. The `GITHUB_TOKEN` lives in `.claude/settings.local.json` (not in any `.env*`); the deny ensures no `.env*` accidentally leaks through.

### 4F — Sister `.claude/` self-modification (HARD DENY for pipeline agents)

`Edit(/root/projects/fullstack/twenty-crm/twenty-crm/.claude/agents/**)`, `Edit(/root/projects/fullstack/twenty-crm/twenty-crm/.claude/skills/**)`, `Edit(/root/projects/fullstack/twenty-crm/twenty-crm/.claude/settings.json)`, `Edit(/root/projects/fullstack/twenty-crm/twenty-crm/.claude/settings.local.json)`, `Edit(/root/projects/fullstack/twenty-crm/twenty-crm/.claude/hooks/**)`. Same for `Write` + `MultiEdit`.

Rationale: prevents pipeline agents (triager/implementer/auditor/closer) from mutating their own agent prompts, skills, settings, or hooks during a session. The supervisor (main session) edits these from the top level. NOTE: this is path-scoped to the in-project `.claude/`; the SISTER-roots at `/root/.claude/agents/**` etc. are intentionally allowed because they're the upstream definitions used by the harness (different sense of "sister" path).

### 4G — PROMPT-ON-USE (NOT in deny; falls through to `acceptEdits` prompt)

**Important**: these commands are NOT listed in `permissions.deny`. They simply have no allow rule, so the mode prompts the user. The user approves case-by-case. The list is here for documentation only — the rules file doesn't include them in `deny`.

| Category | Commands | When the supervisor typically approves |
|---|---|---|
| Git mutating | `git commit *`, `git push *`, `git checkout -- *`, `git merge *`, `git rebase *`, `git reset --hard *`, `git stash *`, `git tag *`, `git branch -D *`, `git remote add/rm *`, `git config --set/unset/replace-all *`, `git clean -f/d *` | End of an audit-clean cycle (commit + push), back-merging upstream tags, recovering from a botched merge |
| Docker mutating | `docker compose up *`, `docker compose down *`, `docker compose build *`, `docker compose pull *`, `docker compose restart/stop/start *`, `docker run *`, `docker push *`, `docker login *`, `docker rm/rmi/stop/start/restart/exec *`, `docker volume rm/create *`, `docker network rm/create *` | Bringing up/recreating the local stack, building/pushing fork images to GHCR, cleaning orphan volumes |
| Package installs | `yarn install`, `yarn add *`, `yarn remove *`, `npm install *`, `npm i *`, `pnpm install/add/remove *`, `pip install *`, `pip3 install *`, `brew install *`, `apt install *`, `apt-get install *`, `dpkg -i *` | When a plan's `## Proposed fix` legitimately adds/removes a dependency (rare; e.g., issue #21 removed `twenty-shared`) |
| Lockfile / CI / package.json (Edit/Write) | `Edit(/**/yarn.lock)`, `Edit(/**/package.json)`, `Edit(/**/package-lock.json)`, `Edit(/**/.gitignore)`, `Edit(/**/.github/workflows/**)` | After a `yarn install` regenerates lockfile; when plan modifies workflow file |
| `docker compose exec` / `docker exec` | `docker exec *`, `docker compose exec *` | Manual debugging into a running container (rare) |
| Kubernetes | `kubectl *`, `helm *` | **None of these are used in twenty-crm today.** Left as prompt-on-use so that IF someone wants to extend to k8s, the prompt informs them rather than silently denies. If you confirm no k8s plans, we can move these to hard-deny in a v2. |

These all prompt the user when the supervisor (main session) runs them. Pipeline agents still refuse via their body prompts.

---

## Section 5 — Path-scoped file permissions

Allowed roots (mirror these in `additionalDirectories` + `scope-edits.sh` case statement):

```
/root/projects/fullstack/twenty-crm/twenty-crm/**
/root/.claude/agents/**
/root/.claude/skills/**
/root/.claude/projects/-root-projects-fullstack-twenty-crm-twenty-crm/memory/**
/root/.claude/plans/**
```

The `scope-edits.sh` hook does case-match validation on each Edit/Write/MultiEdit invocation. Anything outside these roots → JSON deny output → write aborts. `Read` is allow-all minus the sensitive deny patterns in 4H.

---

## Section 6 — Hooks

All hooks live at `.claude/hooks/`, are bash scripts, executable, registered in `settings.json`'s `hooks` object. Each fails safe: any error → exit 0 silently. Hooks never block legitimate work.

### 6A — `scope-edits.sh` (PreToolUse, matcher `Edit|Write|MultiEdit`, timeout 5s)

Reads tool envelope from stdin, extracts `tool_input.file_path` (or `.path`), normalizes leading `//`, case-matches against the 5 allowed roots from Section 5. If no match → emits `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"scope: path outside allowed roots"}}` and exits 0. If match → exits 0 silently (allow falls through to rule check).

### 6B — `block-destructive-bash.sh` (PreToolUse, matcher `Bash`, timeout 5s)

Reads tool envelope from stdin, extracts `tool_input.command`. Applies a chain of `grep -qE` regexes; any match → emit deny JSON + exit 0. **The hook patterns are scoped to Tier-1 (HARD DENY) commands only** — Tier-2 prompt-on-use commands (Section 4G) are deliberately NOT blocked by the hook (they fall through to the mode's prompt).

Patterns:

1. `\brm\s+-[rRfF]+` (rm with destructive flags — Tier 1)
2. `\bsudo\b|\bsu\s` (privilege — Tier 1)
3. `\b(wget|nc|ncat|ssh|scp|rsync|ftp|sftp|telnet)\b` (non-curl network — Tier 1)
4. `\bcurl\b` **unless** URL prefix is `https://api.github.com/repos/LazyBouy/twenty-crm/` OR `http://(localhost\|127\.0\.0\.1):(4440\|4441)/` OR `https://api.github.com/user` (single regex with alternation; everything else falls through to prompt)
5. `\bdd\s+(if|of)=|\bmkfs(\.|\b)` (disk destruction — Tier 1)
6. `\bchmod\s+-?R?\s*777\b`, `\bchown\s+-R\b` (broad ownership/permission — Tier 1)
7. `\bfind\b.*-delete\b` (find -delete — Tier 1)
8. `\b(sed|awk|perl)\s+-i\b` (in-place edits — Tier 1)
9. `\bnpx\s+(prettier\s+--write|eslint\s+--fix|oxlint\s+--fix|nx\s+(fmt|lint\s+--configuration=fix))` (auto-fixers — Tier 1, per L13 incident)
10. `\b(prettier\s+--write|prettier\s+-w|eslint\s+--fix|oxlint\s+--fix)\b` (bare-form auto-fixers — Tier 1)
11. **Shell redirection writing to sensitive paths** (subset of L_audit_procedural defense): `(>>?|tee\s+-?a?)\s+(/etc/|/usr/|/var/|.*\.env(\.|\s|$)|.*credentials\.json|.*secrets\.json|.*\.ssh/|.*\.aws/|.*\.gnupg/|.*\.npmrc|.*\.netrc|.*\.gitconfig|.*\.git/config)` — blocks writes to credentials/host-config paths even when bash redirection bypasses the Edit/Write tool. Less aggressive than phi's "all `>>` redirection forbidden" because under `acceptEdits` the user gets to approve legitimate redirections (e.g. `echo 'foo' >> /tmp/notes.txt`).
12. **Sister `.claude/` redirection write** — same regex form, target `.claude/(agents|skills|hooks|settings.json|settings.local.json)`. Belt-and-suspenders against agents trying to mutate their own prompts via bash redirection.

**Deliberately NOT blocked by hook** (let the mode prompt instead):
- `git commit/push/reset/rebase/merge/stash/checkout--/tag/clean` (Tier 2 — prompt-on-use)
- `docker compose up/down/build/pull/restart/stop/start`, `docker run/push/login/rm/rmi/exec/volume/network`
- `npm/yarn/pnpm install`, `pip install`, `apt install`, `brew install`
- `kubectl`, `helm` (TBD: move to Tier 1 once user confirms no k8s plans)
- `tee`, `cp`, `mv` (legitimate uses exist; the patterns in #11 catch the specifically-sensitive forms)

### 6C — `log-tool-use.sh` (PostToolUse, PostToolUseFailure, PermissionRequest; matcher `.*`; timeout 3s each)

Three hook registrations, each calls the same script with a positional argument (`PostToolUse`, `PostToolUseFailure`, or `PermissionRequest`). Script:

1. Reads tool envelope from stdin.
2. Self-skip: if the envelope's input mentions `tool-use.log`, exit 0 (avoid recursion).
3. Extracts fields (event, tool, tool_use_id, turn_index, input).
4. Computes `input_signature` per a deterministic clustering function (e.g., `Bash` → first 2 words; `Edit` → file extension + directory; `WebFetch` → host; `Agent` → subagent_type). Same as phi's `log-tool-use.sh:25-48`.
5. Truncates `input_full` to 1000 chars (with `…`).
6. Redacts env-var values matching `\b(SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)[A-Z_]*=[^[:space:]]+` → `<redacted>`. Sets `redacted=true`.
7. Builds JSONL record per Section 7 schema.
8. Acquires `flock -w 1` on `.claude/tool-use.log.lock`; if blocked, drop record (logging never blocks).
9. Appends to `.claude/tool-use.log`.
10. If log > 10 MiB: rotates `.log` → `.log.1`, `.log.1` → `.log.2`, etc., up to `.log.5`.
11. Always `exit 0` (`set -uo pipefail`, NOT `-e`).

---

## Section 7 — Telemetry log spec

`.claude/tool-use.log`, JSONL, gitignored. Schema v1, one record per tool call:

```
ts              string  ISO-8601 with ms, UTC ("2026-05-13T09:00:00.123Z")
event           string  "PostToolUse" | "PostToolUseFailure" | "PermissionRequest"
tool            string  "Bash" | "Edit" | "Write" | "Read" | "Grep" | "Glob" | "Agent" | "WebFetch" | ...
tool_use_id     string  correlates multi-event chains
turn_index      int     conversation turn
input_signature string  clustering key (e.g., "Bash:npx-jest", "Edit:plans/", "WebFetch:api.github.com")
input_full      string  ≤1000 chars, truncated with "…"
outcome         string  "success" | "failure" | "prompted" | "denied" | "unknown"
duration_ms     int|null  PostToolUse only
output_summary  string  ≤200 chars, newlines→space
error_summary   string|null  PostToolUseFailure only
redacted        bool    true if env-var values redacted
version         int     1 (schema version)
```

- **Rotation**: 10 MiB threshold, keep 5 rotations.
- **Redaction**: regex `\b(SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)[A-Z_]*=[^[:space:]]+` → `<redacted>`. `redacted=true` set.
- **Concurrency**: `flock -w 1` on `.log.lock`; on contention, silently skip.
- **Self-skip**: if envelope mentions log path, exit 0 without logging.
- **Failure mode**: all errors → exit 0 silently. Hook MUST never block workflow.

---

## Section 8 — Permissions-auditor agent

### 8A — Agent file: `.claude/agents/permissions-auditor.md`

```yaml
---
name: permissions-auditor
description: Reads .claude/tool-use.log + .claude/settings.json, classifies findings (hot allow-rule candidates, dead rules, hook denials, workflow issues, cross-cycle trends), writes a markdown audit report to .claude/state/permissions-audit-<ISO>.md. Invoked via /audit-permissions. Never edits source, never edits settings.json itself — only the supervisor applies policy changes.
model: sonnet
color: cyan
tools: Read, Write, Bash, Grep, Glob
---
```

Model rationale: sonnet, not opus. This is log parsing + tabulation, not adversarial code review. Per the user's preference for cost discipline, the simpler model fits.

### 8B — Procedure (full agent body — abbreviated here for plan brevity)

1. **Args**: `<start_ts>` `<end_ts>` (optional; defaults: prior audit's end_ts → now).
2. **Resolve window**: read `.claude/state/permissions-audit-*.md` filenames (timestamp in name); pick the most-recent; that's start_ts. End_ts = now.
3. **Load + filter**: `cat .claude/tool-use.log .claude/tool-use.log.* 2>/dev/null | jq -c 'select(.ts >= $s and .ts <= $e and .version == 1)'`. Skip malformed lines silently.
4. **Aggregate** by `(event, tool, input_signature)`: count, first_ts, last_ts, 3 most-recent sample `input_full` values, set of `tool_use_id`.
5. **Cross-reference settings.json rules**: parse `permissions.allow` + `permissions.deny` into structured form. For each `(tool, input_signature)`, simulate Claude Code's matcher (deny > hook-deny > allow > default-mode), record first matching rule.
6. **Correlate** `tool_use_id` across event types to distinguish prompted-then-approved vs prompted-then-denied vs auto-approved vs hook-denied.
7. **Classify into 8 sections** (mirror phi's §A–§H):
   - §A — Tool distribution (frequency table per tool)
   - §B — Hot allow-rule candidates: signatures with ≥3 `PermissionRequest` events and no matching allow rule. **Includes regression-protection escalation** (rule-pattern-failed-validation → matcher-semantics-investigation → matcher-bug-confirmed → resolved-via-workaround lifecycle).
   - §C — Auto-approved by mode (visibility only — what `acceptEdits` auto-accepted via allow-rule match, and what fell through to user-approved prompt)
   - §D — Allow-rule utilization: 0-hit rules flagged "unused this cycle"; ≥3 consecutive zero-hit cycles → "removal candidate"
   - §E — Hook denials: grouped by hook + reason; same-signature denied ≥2× in 60s window → flag potential false positive
   - §F — High-frequency rejected patterns (≥5 denials in window)
   - §G — Cross-cycle trends (if prior audit reports exist)
   - §H — Proposed standards updates (concrete rule additions/removals in Claude Code syntax)
8. **Proposed rule synthesis**: for `prog:firstarg` Bash signatures → `Bash(prog firstarg *)`; for path signatures → `Edit(//path/**)`; for WebFetch → `WebFetch(domain:<host>)`. Always emit valid Claude Code syntax.
9. **Output**: write to `.claude/state/permissions-audit-<ISO-with-dashes>.md`. Filename pattern: `permissions-audit-2026-05-13T09-00-00Z.md`.
10. **Final supervisor message**: 5-line summary citing report path + top-3 §H proposed actions.

### 8C — When it runs (user decision: on-demand)

- **On-demand**: user types `/audit-permissions [start_ts] [end_ts]` → skill invokes agent → agent writes report → user reviews.
- **NOT auto-fired** at end of `/triage-issues` or `/close-issue` (user decision: minimize noise during early adoption; promote to automatic after ~10 cycles if log volume warrants).

### 8D — Cross-cycle regression-protection (v1 scope)

Implements the simplest layer: hot-rule candidate that persists across N audits → tag with `rule-pattern-failed-validation` severity. Future hardening (matcher-semantics-investigation, matcher-bug-confirmed lifecycle states from phi's `permissions-audit.md:76-79`) is deferred to v2 once we have audit data to justify the complexity.

---

## Section 9 — Audit skill

### `.claude/skills/audit-permissions/SKILL.md`

```markdown
---
name: audit-permissions
description: Run the permissions-auditor agent over a time window; produces a markdown report at .claude/state/permissions-audit-<ISO>.md.
---

# /audit-permissions `[start_ts] [end_ts]` — on-demand permission telemetry audit

## Arguments

Both optional:
- `<start_ts>` — ISO-8601 timestamp (e.g., `2026-05-12T00:00:00Z`). Default: end_ts of most-recent prior audit (or "7 days ago" if none).
- `<end_ts>` — ISO-8601 timestamp. Default: now.

## Pre-flight (supervisor)

1. Confirm `.claude/tool-use.log` exists (created by `log-tool-use.sh`); if not, stop with "telemetry log not yet created — wait for hooks to fire at least once."
2. Confirm `.claude/settings.json` is readable.

## Flow

1. Spawn `permissions-auditor` agent with args `<start_ts> <end_ts>`.
2. Agent writes report; supervisor reads report path from agent's final message.
3. Supervisor reads top-3 proposed §H actions and surfaces to user.

## What the user does

Reads report. Decides which §H actions to apply. Edits `.claude/settings.json` directly. Commits + pushes if settings.json is git-tracked. Next session inherits.

## What you (supervisor) never do

- Never edit `.claude/settings.json` programmatically from this skill — let the user do it.
- Never close findings — they remain on disk in the report for permanent record.
```

---

## Section 10 — Workflow

### Initial setup (user, one-time)

1. Edit root `.gitignore` to add `!.claude/settings.json` and `!.claude/hooks/` after the existing `.claude/*` deny + `!.claude/agents/` + `!.claude/skills/` exceptions.
2. Create the 8 new files listed in Section 1's table.
3. `chmod +x .claude/hooks/*.sh`.
4. Restart Claude session — `acceptEdits` mode + hooks become active.
5. Commit all new files. The `.env` / token / state / log files remain gitignored.

### Each session (automatic)

1. Agents run normally. The decision tree per Bash call:
   - **Allow rule matches** → silent auto-accept.
   - **Hard-deny rule or hook regex matches** → blocked, no prompt.
   - **Neither matches** → user gets a one-line prompt; approve or deny per-invocation.
2. For Edit/Write/MultiEdit:
   - **scope-edits.sh hook** validates path is in allowed roots — out-of-roots writes are denied.
   - **In-roots writes** → auto-accepted (acceptEdits semantics).
3. PostToolUse / PostToolUseFailure / PermissionRequest hooks append JSONL to `.claude/tool-use.log` for every tool call, regardless of decision.
4. Hooks fail-safe: any hook error → exit 0 silently → workflow continues. Hooks never block legitimate work.

**Expected prompt frequency** in steady state (after ~3 audit cycles tune the allow list):
- Commit cycles: 1–2 prompts per cycle (e.g., `git commit -m '…'`, `git push`).
- Local stack restart: 2–4 prompts (`docker compose up/down/build`).
- VPS deploy: 3–5 prompts (`git push`, `docker compose pull`, `up`, etc.).
- Routine pipeline (triage → implement → audit → commit hand-off): 0 prompts after allow list is tuned.

### Each audit cycle (on-demand)

1. User types `/audit-permissions`.
2. Permissions-auditor agent runs Section 8B procedure, writes report to `.claude/state/permissions-audit-<ISO>.md`.
3. User reads §H "proposed standards updates," decides which to apply.
4. User edits `.claude/settings.json` directly (no agent has write access).
5. User commits + pushes; next session inherits the updated policy.

### Policy update lifecycle

Adding/removing a rule = single human Edit + commit. Hooks are stable enough that they rarely change; when they do, treat as full code review.

---

## Critical files to create/modify

**Modify**:
- `/root/projects/fullstack/twenty-crm/twenty-crm/.gitignore` — add 2 lines exempting `settings.json` and `hooks/`

**Create** (all new):
- `/root/projects/fullstack/twenty-crm/twenty-crm/.claude/settings.json` — base policy (Sections 2–5)
- `/root/projects/fullstack/twenty-crm/twenty-crm/.claude/hooks/scope-edits.sh` — Section 6A
- `/root/projects/fullstack/twenty-crm/twenty-crm/.claude/hooks/block-destructive-bash.sh` — Section 6B
- `/root/projects/fullstack/twenty-crm/twenty-crm/.claude/hooks/log-tool-use.sh` — Sections 6C + 7
- `/root/projects/fullstack/twenty-crm/twenty-crm/.claude/agents/permissions-auditor.md` — Section 8
- `/root/projects/fullstack/twenty-crm/twenty-crm/.claude/skills/audit-permissions/SKILL.md` — Section 9
- `/root/projects/fullstack/twenty-crm/twenty-crm/plans/2026-05-13-claude-permissions-system.md` — institutional-memory copy of this plan (anchored in repo, separately from `/root/.claude/plans/` ephemera)

**Reference (do not modify)**:
- `/root/projects/phi/.claude/settings.json` — phi's mature settings (use as scaffolding)
- `/root/projects/phi/.claude/hooks/*.sh` — phi's hook scripts (mostly copy-paste with path adjustments)
- `/root/projects/phi/.claude/skills/permissions-audit.md` — phi's skill (we keep the structure but rebuild as an agent for twenty-crm per user's request)
- `/root/projects/phi/baby-phi/docs/specs/permissions/*.md` — three reference plans (especially `granular-bash-discipline-ab19399b.md` for matcher semantics)

---

## Verification

End-to-end test of the permission system after implementation:

1. **Smoke test — hooks fire**:
   - Try to write `/tmp/foo.txt` (outside roots): scope-edits.sh should deny.
   - Try `Bash(rm -rf /)`: block-destructive-bash.sh should deny.
   - Try `Bash(git status)`: passes (allow rule + no hook deny).
   - Inspect `.claude/tool-use.log` — should have entries for each of the above.

2. **Smoke test — telemetry log**:
   - Run a `Bash(npx jest)` call from inside an agent.
   - `tail -n 1 .claude/tool-use.log | jq` — should show a valid JSONL record with `event=PostToolUse`, `tool=Bash`, `input_signature=Bash:npx-jest`, `outcome=success`.

3. **Smoke test — log rotation**:
   - Manually grow the log past 10 MiB (or temporarily lower the threshold to 100 KiB in the script).
   - Trigger one more tool call; verify `.log` → `.log.1` rename happens; new `.log` is empty.

4. **Smoke test — audit agent**:
   - After ~10 minutes of normal pipeline use (1 `/triage-issues` cycle), type `/audit-permissions`.
   - Verify report file exists at `.claude/state/permissions-audit-<ISO>.md`.
   - Verify report has sections §A–§H with at least §A populated.

5. **Regression test — pipeline still works**:
   - Run a full `/triage-issues` → implementer → auditor → close cycle.
   - Verify no false-deny hooks block legitimate operations.
   - Verify no agent gets stuck in `PermissionRequest` loops.

6. **Self-policy test — agent can't modify policy**:
   - Have a pipeline agent attempt `Edit(.claude/settings.json)` — should be denied by Section 4I.
   - Verify supervisor (main session) can still edit it from the top level.

7. **Audit cycle dry-run**:
   - After the smoke tests, trigger `/audit-permissions` and review the report's §B (hot allow-rule candidates) and §D (allow-rule utilization).
   - Apply 1–2 proposed updates to settings.json. Restart. Re-run audit. Verify the previously-hot signatures no longer appear in §B (rule pattern matched).

If all 7 verifications pass, the permission system is operational. Cross-cycle trend protection (§B escalation lifecycle) becomes meaningful after ~3 audit cycles of accumulated data.
