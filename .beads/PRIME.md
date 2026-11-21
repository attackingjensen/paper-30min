# Beads Workflow Context

> **Context Recovery**: Run `bd prime` after compaction, clear, or new session.

## Core Rules

- **Task tracking**: Use beads for ALL task tracking (`bd create`, `bd ready`, `bd update`, `bd close`).
- **Local checklists**: Agent built-in todo tools may track execution steps within the current task; beads stays the durable project tracker. Do not use markdown TODO files as project task state.
- **Memory**: Do NOT use `bd remember` or `bd memories`. Persistent knowledge belongs to OpenViking; review and memory revision are triggered by the user, not by routine task completion.
- **Workflow**: Create or claim a beads issue BEFORE writing code; mark `in_progress` when starting.

## Essential Commands

### Finding Work
- `bd ready` — Show issues ready to work (no blockers)
- `bd list --status=open` — All open issues
- `bd list --status=in_progress` — Active work
- `bd show <id>` — Detailed issue view with dependencies

### Creating & Updating
- `bd create --title="..." --type=task|bug|feature --acceptance="..."` — New issue
- `bd create ... --parent=<id>` — Child issue under an epic/phase
- `bd update <id> --claim` — Claim work
- `bd update <id> --status=in_progress` — Mark started
- `bd close <id> --reason="..."` — Complete with evidence
- `bd close <id1> <id2> ...` — Close multiple issues

### Dependencies
- `bd dep add <issue> <depends-on>` — Add blocking dependency
- `bd dep cycles` — Check for cycles
- `bd lint` — Check issue graph rules

### Session Close
1. Close finished issues with evidence (commands, outputs, commit hashes, test names).
2. Create beads for any remaining follow-up work.
3. Report changed files and validation results.

## Project Notes

- Issue graph rules: `docs/agents/issue-tracker.md`.
- Only one level of parent-child nesting; checkpoints have only incoming edges.
- No root epic; version identity goes in title prefix + labels.
