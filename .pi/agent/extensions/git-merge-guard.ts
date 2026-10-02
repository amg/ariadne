/**
 * Git Merge Guard Extension
 *
 * Enforces --no-ff merges to master by intercepting bash tool calls.
 * Blocks git merge commands that lack the --no-ff flag and instructs
 * the agent to read the project git-workflow skill.
 *
 * Location: .pi/agent/extensions/git-merge-guard.ts
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    // Only intercept bash commands
    if (event.toolName !== 'bash') {
      return undefined;
    }

    const command = event.input.command as string | undefined;
    if (!command) {
      return undefined;
    }

    // Detect git merge commands (case insensitive)
    const isGitMerge = /git\s+merge/i.test(command);
    if (!isGitMerge) {
      return undefined;
    }

    // Check for --no-ff flag (also accept -no-ff or --no-ff=true variants)
    const hasNoFf = /--?no-ff/.test(command);

    if (!hasNoFf) {
      // Block the merge and instruct to read git-workflow skill
      if (ctx.hasUI) {
        ctx.ui.notify('⛔ Git merge blocked: missing --no-ff flag', 'warning');
      }
      return {
        block: true,
        reason:
          'Project git-workflow skill requires --no-ff for all merges to master.\n\n' +
          '📖 Read the git-workflow skill before git operations:\n' +
          '   Location: .pi/SKILLS-INDEX.md\n' +
          '   Skill: .pi/agent/skills/git-workflow/SKILL.md\n\n' +
          '✅ Re-run with: git merge --no-ff <branch>',
      };
    }

    return undefined;
  });
}
