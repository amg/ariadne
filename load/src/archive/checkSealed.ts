import type { Manifest } from '../records/index.ts';
import { describeFile } from './files.ts';
import { checkChecksums } from './selfChecks.ts';

/** The files of a sealed run folder that no longer match its manifest. Nothing is changed to repair them. */
export function checkSealed(folder: string, manifest: Manifest) {
  return checkChecksums(manifest.files, (path) => describeFile(folder, path));
}
