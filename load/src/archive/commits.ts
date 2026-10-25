import { execFileSync } from 'node:child_process';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

/**
 * The commit this checkout stands at, and whether files differ from it. A
 * checkout git cannot read is named `unknown` and counted as changed, so
 * a run never claims a commit it cannot name.
 */
export function currentCommit() {
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
    return { sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '' };
  } catch {
    return { sha: 'unknown', dirty: true };
  }
}
