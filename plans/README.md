# `plans/` — meta-system plans for the Twenty CRM workflow

Cross-package and workflow-infrastructure plans live here. Per-fix bug plans live under `packages/<pkg>/plans/`.

## Convention

- Filename: `YYYY-MM-DD-<short-slug>.md` (date is the plan-approval date).
- Plans stay verbatim once approved — edit the next plan, don't rewrite a past one.
- Retrospectives, if written, sit next to the plan as `<plan-basename>-retrospective.md`.
- Add a row to the index below when archiving a new plan.

## Index

| Date | Plan | Status | Summary |
|---|---|---|---|
| 2026-05-02 | [issue-triage-agent-system](2026-05-02-issue-triage-agent-system.md) | implemented | First-cut agent system: `issue-triager`, `issue-implementer`, `issue-closer` + their skills; daily cron + GitHub PAT integration via `.claude/settings.local.json`. |
| 2026-05-02 | [audit-pipeline](2026-05-02-audit-pipeline.md) | implemented | Adds `issue-auditor` (Opus) + `/audit-fix` skill, severity-tiered defect routing (critical/high block, medium → new issue, low → annotate), shifts retrospective writing pre-commit, codifies R6 in `packages/twenty-mcp/CLAUDE.md`. |
