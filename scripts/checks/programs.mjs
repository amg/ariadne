/**
 * The TypeScript programs of every workspace, loaded the way the compiler sees them,
 * for the checks that read the type graph.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Each workspace's tsconfig: the one that holds its source and tests. */
const CONFIGS = [
  'backend/tsconfig.json',
  'load/tsconfig.json',
  'infra/tsconfig.json',
  'frontend/tsconfig.app.json',
  'lib/tsconfig.json',
];

/** A file's path from the repo root. */
export const rel = (file) => relative(ROOT, file);

function loadProgram(configName) {
  const configPath = join(ROOT, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

/** One program per workspace. */
export const loadPrograms = () => CONFIGS.map(loadProgram);

/** The repo's own source files of a program: no declarations, dependencies or generated files. */
export function sourceFilesOf(program) {
  return program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && !rel(file.fileName).startsWith('..'))
    .filter((file) => !file.fileName.includes('node_modules') && existsSync(file.fileName))
    .filter((file) => !file.fileName.endsWith('.generated.ts'));
}

/** The source files of all the programs, each listed once although several programs reach it. */
export function uniqueSourceFiles(programs) {
  const byName = new Map(programs.flatMap(sourceFilesOf).map((file) => [file.fileName, file]));
  return [...byName.values()];
}
