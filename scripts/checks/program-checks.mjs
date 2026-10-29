#!/usr/bin/env node
/**
 * program-checks — runs the checks that read the TypeScript programs, all against one
 * load of the programs, since building them is most of each check's cost.
 *
 * A check is a module exporting `{ name, run }`. `run({ programs, files })` receives
 * every workspace's program and their source files, each listed once, and returns
 * `{ passed, report }`. Adding a check means writing such a module and listing it in
 * CHECKS.
 *
 * Usage: program-checks.mjs [name...]   runs the named checks, or all of them.
 * Exit code 1 when any check fails, so the gate fails.
 */
import { paramFields } from './param-fields.mjs';
import { loadPrograms, uniqueSourceFiles } from './programs.mjs';
import { typeExports } from './type-exports.mjs';

const CHECKS = [typeExports, paramFields];

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !CHECKS.some((check) => check.name === name));
if (unknown.length > 0) {
  console.error(
    `❌ program-checks: no check named ${unknown.join(', ')}. Known: ${CHECKS.map((check) => check.name).join(', ')}`,
  );
  process.exit(1);
}

const chosen = asked.length === 0 ? CHECKS : CHECKS.filter((check) => asked.includes(check.name));
const programs = loadPrograms();
const files = uniqueSourceFiles(programs);

const results = chosen.map((check) => check.run({ programs, files }));
for (const { passed, report } of results) {
  if (passed) console.log(report);
  else console.error(report);
}
if (results.some((result) => !result.passed)) process.exit(1);
