#!/bin/bash
# .claude/hooks/scope-edits.sh — PreToolUse for Edit / Write / MultiEdit.
# Hard-deny edits to paths outside the allowed roots.
#
# Allowed roots (must be kept in sync with settings.json's `additionalDirectories`
# AND with Section 5 of plans/2026-05-13-claude-permissions-system.md):
#   /root/projects/fullstack/twenty-crm/twenty-crm/**
#   /root/.claude/agents/**
#   /root/.claude/skills/**
#   /root/.claude/projects/-root-projects-fullstack-twenty-crm-twenty-crm/memory/**
#   /root/.claude/plans/**
#
# Hook contract: stdin is a JSON envelope from Claude Code with
#   { "tool_name": "Edit"|"Write"|"MultiEdit", "tool_input": { "file_path"|"path": "..." } }
# Output a deny-decision JSON to stdout if path is outside allowed roots.
# Exit 0 in all cases (we use the JSON decision channel, not exit codes).

set -euo pipefail

PAYLOAD=$(cat)
TOOL_NAME=$(echo "$PAYLOAD" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$PAYLOAD" | jq -r '.tool_input.file_path // .tool_input.path // ""')

# If no file_path (some MultiEdit shapes have a different schema), let the
# rule layer handle it — don't second-guess.
[[ -z "$FILE_PATH" ]] && exit 0

# Normalize: convert any leading // to / for consistent matching against
# absolute filesystem paths.
PATH_NORM="${FILE_PATH#//}"
PATH_NORM="/${PATH_NORM#/}"

allow_match() {
  case "$1" in
    /root/projects/fullstack/twenty-crm/twenty-crm/*) return 0 ;;
    /root/.claude/agents/*) return 0 ;;
    /root/.claude/skills/*) return 0 ;;
    /root/.claude/projects/-root-projects-fullstack-twenty-crm-twenty-crm/memory/*) return 0 ;;
    /root/.claude/plans/*) return 0 ;;
  esac
  return 1
}

if allow_match "$PATH_NORM"; then
  exit 0
fi

jq -n --arg path "$PATH_NORM" --arg tool "$TOOL_NAME" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("scope-edits hook: " + $tool + " to " + $path + " is outside the allowed twenty-crm project + sister roots. Edits restricted to /root/projects/fullstack/twenty-crm/twenty-crm/**, /root/.claude/{agents,skills,plans}/**, /root/.claude/projects/-root-projects-fullstack-twenty-crm-twenty-crm/memory/**.")
  }
}'
exit 0
