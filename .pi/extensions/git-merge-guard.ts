/**
 * Git Merge Guard Extension
 *
 * Blocks any `git merge` that would not leave a true merge commit: a merge
 * without `--no-ff`, a `--squash` merge, or an `--ff-only` merge. Merge
 * control commands (`--abort`, `--continue`, `--quit`) and other
 * `git merge-*` subcommands pass through. Rewriting a branch's own history
 * before the merge is outside this guard.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const gitMerge =
  /(?:^|[\s;&|(])git(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+merge(?=$|[\s;&|)])([^;&|]*)/g;

export function blockedMergeReason(command: string): string | undefined {
  for (const [, args = ''] of command.matchAll(gitMerge)) {
    if (/(?:^|\s)--(?:abort|continue|quit)\b/.test(args)) continue;
    if (/(?:^|\s)--squash\b/.test(args)) return '`git merge --squash` leaves no merge commit';
    if (/(?:^|\s)--ff-only\b/.test(args)) return '`git merge --ff-only` leaves no merge commit';
    if (!/(?:^|\s)--no-ff\b/.test(args)) return '`git merge` without `--no-ff` may fast-forward';
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;

    const command = event.input.command as string | undefined;
    const reason = command ? blockedMergeReason(command) : undefined;
    if (!reason) return undefined;

    if (ctx.hasUI) {
      ctx.ui.notify(`⛔ Git merge blocked: ${reason}`, 'warning');
    }
    return {
      block: true,
      reason: [
        `Merge blocked: ${reason}.`,
        '',
        'Every merge must leave a true merge commit (read the git-merging skill).',
        '✅ Re-run with: git merge --no-ff <branch>',
      ].join('\n'),
    };
  });
}
