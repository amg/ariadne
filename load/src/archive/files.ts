import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { LAYOUT, sha256Of, sha256OfFile } from '../records/index.ts';

export { sha256Of, sha256OfFile };

/** The ending of a file that is still being written, which is never part of a run. */
export const PARTIAL = '.partial';

/** A file's size and checksum; null when there is no such file. */
export function describeFile(root: string, path: string) {
  const full = join(root, path);
  if (!existsSync(full)) return null;
  return { path, size: statSync(full).size, sha256: sha256OfFile(full) };
}

/** Every raw file in a run folder, by path: all but the manifest, a file still being written, the generators' unsorted output and what a rebuild derived. */
export function listRunFiles(root: string) {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(relative(root, full).split('\\').join('/'));
    }
  };
  if (existsSync(root)) walk(root);
  return found
    .filter(
      (path) =>
        !path.endsWith(PARTIAL) &&
        path !== LAYOUT.manifest &&
        !path.startsWith(`${LAYOUT.sourcesDir}/`) &&
        !path.startsWith(`${LAYOUT.derivedDir}/`),
    )
    .sort();
}

/** Writes a file so that it holds either what it held before or all of `content`, and never part of it. */
export function writeWhole(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}${PARTIAL}`;
  writeFileSync(partial, content);
  renameSync(partial, file);
}

/**
 * Writes `content` to `path` in the run folder, unless a file there
 * already holds exactly it. Resolves to whether it wrote.
 */
export function writeOnce(root: string, path: string, content: string) {
  const existing = describeFile(root, path);
  if (existing !== null && existing.sha256 === sha256Of(content)) return false;
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return true;
}
