/**
 * type-exports — keeps an exported type as close as possible to the files that use it.
 * A type is read off the function that produces it (`ReturnType`, `Parameters`,
 * `Awaited`). When several files must share one, it is exported only as far up the
 * tree as it takes to cover them: every importer sits inside the declaring file's folder.
 *
 * Rules, for every `export type` / `export interface` outside the global vocabularies:
 *   R1  no other file imports it                      -> drop the `export`
 *   R2  only test files import it                     -> drop the `export`; the test derives the type
 *   R3  an importer sits outside the declaring folder -> move it to `types.ts` in the lowest folder that holds every importer
 *   R4  a workspace-wide shelf, or a `types.ts`, holds a type that only a folder below it imports -> move it down to that folder
 *
 * Imports are resolved with the compiler's checker, so barrels, aliases and
 * path mappings are followed to the declaring file.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import ts from 'typescript';
import { ROOT, rel, sourceFilesOf } from './programs.mjs';

/** Where a workspace keeps the types that its whole codebase shares. */
const SHELVES = [
  'backend/src/types/',
  'frontend/src/types/',
  'load/src/types/',
  'infra/lib/types/',
];

/**
 * The global vocabularies, where a type may be imported from anywhere: the wire
 * contract, the stored rows, and each workspace's top-level shelf of shared words.
 */
const VOCABULARY = [
  'lib/',
  'load/src/records/',
  'frontend/src/services/api.ts',
  'backend/src/db/types.ts',
  'infra/config/',
  ...SHELVES,
];

/** Types that stay exported beside the const they describe; each carries its reason. Keyed `path#Name`. */
const ALLOWED = JSON.parse(
  readFileSync(join(ROOT, 'scripts/checks/type-exports.allow.json'), 'utf8'),
);

const isVocabulary = (path) => VOCABULARY.some((entry) => path.startsWith(entry));
const isTestSupport = (path) =>
  /\.test\.tsx?$|(^|\/)testing\.ts$|\/test\/|\/testing\/|\/mock\//.test(path);
const within = ({ path, folder }) =>
  dirname(path) === folder || dirname(path).startsWith(`${folder}/`);

function exportedTypesOf(sourceFile) {
  const types = sourceFile.statements.filter(
    (statement) => ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement),
  );
  return types
    .filter((statement) =>
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map((statement) => ({
      name: statement.name.text,
      line: sourceFile.getLineAndCharacterOfPosition(statement.name.getStart()).line + 1,
    }));
}

const keyOf = ({ symbol }) => {
  const declaration = symbol.declarations?.[0];
  return declaration && `${rel(declaration.getSourceFile().fileName)}#${symbol.name}`;
};

/** The `path#Name` an imported name ends up at, after following barrels and aliases. */
function keyOfImportedName({ checker, name }) {
  const symbol = checker.getSymbolAtLocation(name);
  return symbol ? keyOf({ symbol: checker.getAliasedSymbol(symbol) }) : undefined;
}

/** Every name a `import * as ns` can reach counts as imported. */
function keysOfNamespace({ checker, namespaceImport }) {
  const symbol = checker.getSymbolAtLocation(namespaceImport.name);
  const module = symbol && checker.getAliasedSymbol(symbol);
  const exported = module ? checker.getExportsOfModule(module) : [];
  const resolved = exported.map((member) =>
    member.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(member) : member,
  );
  return resolved.map((symbol) => keyOf({ symbol }));
}

function importedKeysOf({ checker, file }) {
  const bindings = file.statements
    .filter((statement) => ts.isImportDeclaration(statement))
    .map((statement) => statement.importClause?.namedBindings)
    .filter(Boolean);
  return bindings.flatMap((binding) =>
    ts.isNamespaceImport(binding)
      ? keysOfNamespace({ checker, namespaceImport: binding })
      : binding.elements.map((element) => keyOfImportedName({ checker, name: element.name })),
  );
}

/** Which files import each `path#Name`. */
function importersOf(programs) {
  const importers = new Map();
  for (const program of programs) {
    const checker = program.getTypeChecker();
    for (const file of sourceFilesOf(program)) {
      for (const key of importedKeysOf({ checker, file }).filter(Boolean)) {
        if (!importers.has(key)) importers.set(key, new Set());
        importers.get(key).add(rel(file.fileName));
      }
    }
  }
  return importers;
}

/** The lowest folder that holds every one of the files. */
function commonFolder(paths) {
  const folders = paths.map((p) => dirname(p).split('/'));
  return folders[0].filter((part, i) => folders.every((f) => f[i] === part)).join('/');
}

/** Where a type belongs: `types.ts` in `home`, or the workspace shelf when `home` is the workspace itself. */
function homeHint(home) {
  const workspace = home.split('/')[0];
  const shelf = SHELVES.find((entry) => entry.startsWith(`${workspace}/`));
  const atWorkspaceLevel = [workspace, `${workspace}/src`, `${workspace}/lib`].includes(home);
  return atWorkspaceLevel && shelf ? shelf : `${home}/types.ts`;
}

function violationOf({ path, line, name, users }) {
  const found = { path, line, name };
  if (users.length === 0) return { ...found, rule: 'R1', users };
  if (users.every(isTestSupport)) return { ...found, rule: 'R2', users };
  const folder = dirname(path);
  const outside = users.filter((user) => !within({ path: user, folder }));
  if (outside.length === 0) return undefined;
  return { ...found, rule: 'R3', users: outside, home: homeHint(commonFolder([path, ...users])) };
}

/** The other declarations in the same file that refer to the type. */
function siblingsMentioning({ sourceFile, name }) {
  const own = sourceFile.statements.find(
    (statement) => statement.name?.text === name && !ts.isVariableStatement(statement),
  );
  const mentions = (node) =>
    (ts.isIdentifier(node) && node.text === name) || node.getChildren().some(mentions);
  return sourceFile.statements.filter((statement) => statement !== own && mentions(statement));
}

/**
 * Every file that depends on a type: its importers, and whoever depends on each
 * sibling type that refers to it. The type has to stay reachable from all of them.
 * A sibling that is not a type keeps the type in its own file.
 */
function dependentsOf({ sourceFile, name, importers, seen }) {
  const path = rel(sourceFile.fileName);
  const own = [...(importers.get(`${path}#${name}`) ?? [])].filter((user) => user !== path);
  const inherited = siblingsMentioning({ sourceFile, name }).flatMap((statement) => {
    const sibling = statement.name?.text;
    if (!sibling) return [path];
    if (seen.has(sibling)) return [];
    return dependentsOf({
      sourceFile,
      name: sibling,
      importers,
      seen: new Set([...seen, sibling]),
    });
  });
  return [...own, ...inherited];
}

/** A type in a `types.ts` that only a folder below it depends on belongs in that folder's `types.ts`. */
function nestedViolationOf({ path, line, name, users, dependents }) {
  if (dependents.length === 0) return undefined;
  const folder = dirname(path);
  const home = commonFolder(dependents);
  if (home === folder || !home.startsWith(`${folder}/`)) return undefined;
  return { path, line, name, rule: 'R4', users, home: `${home}/types.ts` };
}

function shelfViolationOf({ path, line, name, users }) {
  const home = commonFolder(users);
  if (users.length === 0 || homeHint(home).endsWith('/types.ts') === false) return undefined;
  return { path, line, name, rule: 'R4', users, home: homeHint(home) };
}

/** The rules for a type outside the shelves: R1-R3 for any file, and R4 as well in a `types.ts`. */
function typeViolationOf({ sourceFile, path, line, name, users, importers }) {
  const misplaced = violationOf({ path, line, name, users });
  if (misplaced || basename(path) !== 'types.ts') return misplaced;
  const dependents = dependentsOf({ sourceFile, name, importers, seen: new Set([name]) });
  return nestedViolationOf({ path, line, name, users, dependents });
}

/** The rule an exported type breaks, by where it is declared: a shelf, a vocabulary, or anywhere else. */
function exportViolationOf({ sourceFile, path, line, name, importers }) {
  const users = [...(importers.get(`${path}#${name}`) ?? [])].filter((user) => user !== path);
  return SHELVES.some((shelf) => path.startsWith(shelf))
    ? !siblingsMentioning({ sourceFile, name }).length > 0 &&
        shelfViolationOf({ path, line, name, users })
    : !isVocabulary(path) && typeViolationOf({ sourceFile, path, line, name, users, importers });
}

/** The misplaced exported types of the files, and every `path#Name` they declare. */
function violationsIn({ files, importers }) {
  const found = new Map();
  const declared = new Set();
  for (const file of files) {
    const path = rel(file.fileName);
    for (const { name, line } of exportedTypesOf(file)) {
      const key = `${path}#${name}`;
      declared.add(key);
      if (ALLOWED[key] || isTestSupport(path)) continue;
      const violation = exportViolationOf({ sourceFile: file, path, line, name, importers });
      if (violation) found.set(key, violation);
    }
  }
  return { violations: [...found.values()], declared };
}

const ADVICE = {
  R1: 'no other file imports it: drop the `export`',
  R2: 'only tests import it: drop the `export`, let the test derive the type from the function',
  R3: 'an importer sits outside the declaring folder: move the type to the home named below',
  R4: 'only one folder imports it: move the type down to the home named below',
};

function reportOf({ violations, stale }) {
  const lines = [];
  for (const rule of Object.keys(ADVICE)) {
    const group = violations.filter((v) => v.rule === rule);
    if (group.length === 0) continue;
    lines.push(`\n${rule}: ${ADVICE[rule]}`);
    for (const v of group) {
      const home = v.home ? `  (home: ${v.home})` : '';
      lines.push(`  ${v.path}:${v.line}  ${v.name}  <- ${v.users.slice(0, 3).join(', ')}${home}`);
    }
  }
  for (const key of stale) lines.push(`\nstale allow-list entry, no such exported type: ${key}`);
  lines.push(
    `\n❌ type-exports: ${violations.length} exported type(s) in the wrong place, ${stale.length} stale allow-list entr${stale.length === 1 ? 'y' : 'ies'}. See the typescript-conventions skill.`,
  );
  return lines.join('\n');
}

function run({ programs, files }) {
  const { violations, declared } = violationsIn({ files, importers: importersOf(programs) });
  const stale = Object.keys(ALLOWED).filter((key) => !declared.has(key));
  if (violations.length === 0 && stale.length === 0) {
    return {
      passed: true,
      report: '✅ type-exports: every exported type stays within the folder of its importers',
    };
  }
  return { passed: false, report: reportOf({ violations, stale }) };
}

export const typeExports = { name: 'type-exports', run };
