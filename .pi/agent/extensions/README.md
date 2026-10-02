# Project Extensions

Extensions loaded automatically when Pi starts in this project directory.

## git-merge-guard.ts

Blocks `git merge` commands that lack the `--no-ff` flag.

**What it does:**
- Intercepts all bash tool calls
- Detects `git merge` commands
- Blocks execution if `--no-ff` flag is missing
- Returns error with instructions to read git-workflow skill

**Error response includes:**
- Link to `.pi/SKILLS-INDEX.md`
- Link to `.pi/agent/skills/git-workflow/SKILL.md`
- Correct usage example
- Remediation steps

**Why:** Enforces the project git-workflow skill rule that all merges to master must use `--no-ff` to preserve feature branch history.

## Loading

### When Running Pi from Project Directory
Extensions load automatically when Pi starts with `/workspace/alex-chat-bot` as the working directory:
```bash
cd /workspace/alex-chat-bot
pi
```

### When Running Pi from Global Workspace (e.g., `/workspace`)
Project extensions don't auto-load. Load them explicitly:
```bash
# From /workspace
pi -e /workspace/alex-chat-bot/.pi/agent/extensions/git-merge-guard.ts
```

Or add to your global `~/.pi/agent/extensions/` directory if you want them always active.

### Disabling
To disable temporarily, rename the file (e.g., `git-merge-guard.ts.disabled`).
