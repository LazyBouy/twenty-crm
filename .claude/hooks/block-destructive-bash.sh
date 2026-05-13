#!/bin/bash
# .claude/hooks/block-destructive-bash.sh — PreToolUse for Bash.
# Defense-in-depth: regex-deny destructive bash even if rules slip through.
#
# Hook contract: stdin is a JSON envelope from Claude Code with
#   { "tool_name": "Bash", "tool_input": { "command": "..." } }
# Output a deny-decision JSON to stdout if the command matches any blocked pattern.
# Exit 0 in all cases (we use the JSON decision channel, not exit codes).
#
# Scope: Tier-1 (HARD DENY) commands per Section 6B of the plan. Tier-2 prompt-on-use
# commands (git commit/push, docker compose mutations, package installs, etc.) are
# deliberately NOT blocked here — they fall through to acceptEdits mode's user prompt.

set -euo pipefail

PAYLOAD=$(cat)
TOOL_NAME=$(echo "$PAYLOAD" | jq -r '.tool_name // ""')
COMMAND=$(echo "$PAYLOAD" | jq -r '.tool_input.command // ""')

[[ "$TOOL_NAME" != "Bash" ]] && exit 0
[[ -z "$COMMAND" ]] && exit 0

deny() {
  jq -n --arg cmd "$COMMAND" --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("block-destructive-bash hook: " + $reason + " Command: " + $cmd)
    }
  }'
  exit 0
}

# 1. Destructive rm flags
echo "$COMMAND" | grep -qE '\brm\s+-[rRfF]+' && deny "rm with destructive flags blocked; use Edit/Write tool or run from a separate shell outside Claude."
# 2. Privilege escalation
echo "$COMMAND" | grep -qE '\bsudo\b|\bsu\s|\bsu$' && deny "Privilege escalation blocked."
# 3. Non-curl network (data exfiltration vectors)
echo "$COMMAND" | grep -qE '\b(wget|ncat|nc\s+-|ssh\s|scp\s|rsync\s|ftp\s|sftp\s|telnet\s)\b' && deny "Non-curl network I/O blocked. Use WebFetch for URL access, or specific curl whitelisted in allow rules."
# 4. curl restricted to whitelisted hosts (GitHub API for LazyBouy/twenty-crm + localhost loopback)
if echo "$COMMAND" | grep -qE '\bcurl\b'; then
  if ! echo "$COMMAND" | grep -qE '\bcurl[^|&;]*(https://api\.github\.com/repos/LazyBouy/twenty-crm/|https://api\.github\.com/user|http://(localhost|127\.0\.0\.1):(4440|4441)/|https://api\.github\.com/[^/]+/[^/]+/forks)'; then
    deny "curl restricted to api.github.com/repos/LazyBouy/twenty-crm + api.github.com/user + localhost:4440/4441. Add an explicit allow rule for new endpoints."
  fi
fi
# 5. Disk-level operations
echo "$COMMAND" | grep -qE '\bdd\s+(if|of)=|\bmkfs(\.|\b)|>\s*/dev/sd[a-z]' && deny "Disk-level operation blocked."
# 6. Broad chmod/chown
echo "$COMMAND" | grep -qE '\bchmod\s+-?R?\s*777\b' && deny "chmod 777 blocked."
echo "$COMMAND" | grep -qE '\bchown\s+-R\b' && deny "chown -R blocked."
# 7. find -delete (would bypass scope-edits hook entirely)
echo "$COMMAND" | grep -qE '\bfind\b.*-delete\b' && deny "find -delete blocked; use rm explicitly via your terminal or Edit/Write tool."
# 8. In-place sed/awk/perl (bypasses scope-edits hook)
echo "$COMMAND" | grep -qE '\b(sed\s+-i|sed\s+--in-place|awk\s+-i\s+inplace|perl\s+-i)\b' && deny "In-place file edit (sed -i / awk -i / perl -i) blocked; use the Edit tool instead."
# 9. Auto-fixers via npx (L13 incident: auditor used prettier --write + git checkout, lost in-flight refactor)
echo "$COMMAND" | grep -qE '\bnpx\s+(prettier\s+--?w(rite)?|eslint\s+--fix|oxlint\s+--fix|nx\s+(fmt|lint\s+--configuration=fix))' && deny "Auto-fixer blocked. Use prettier --check / eslint without --fix to inspect, never to mutate."
# 10. Auto-fixers in bare form
echo "$COMMAND" | grep -qE '\b(prettier\s+--?w(rite)?|eslint\s+--fix|oxlint\s+--fix)\b' && deny "Auto-fixer blocked (bare form). Use prettier --check / eslint without --fix to inspect, never to mutate."
# 11. Shell redirection writing to sensitive paths
if echo "$COMMAND" | grep -qE '(>>?|\btee\s+(-a\s+)?)\s*(/etc/|/usr/|/var/|.*\.env(\.|\s|$|>)|.*credentials\.json|.*secrets\.json|.*/\.ssh/|.*/\.aws/|.*/\.gnupg/|.*/\.npmrc|.*/\.netrc|.*/\.gitconfig|.*/\.git/config)'; then
  deny "Shell redirection writing to sensitive path (credentials / host config) blocked. Use the Edit tool with explicit path validation, or write outside the sensitive prefix."
fi
# 12. Shell redirection writing to sister .claude/ (defense against agent self-modification via bash)
if echo "$COMMAND" | grep -qE '(>>?|\btee\s+(-a\s+)?)\s*(/root/projects/fullstack/twenty-crm/twenty-crm/)?\.claude/(agents|skills|hooks|settings\.json|settings\.local\.json)'; then
  deny "Shell redirection writing to .claude/{agents,skills,hooks,settings.json} blocked. The supervisor (main session) edits these via the Edit tool from the top level."
fi

exit 0
