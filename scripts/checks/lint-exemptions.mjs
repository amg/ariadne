/**
 * lint-exemptions — no file is newly exempted by name from the readability rules.
 *
 * A Biome override can switch a rule off for a list of paths. A path written out in full
 * exempts one file, and such a list only ever shrinks as its files are reshaped. The
 * check compares biome.jsonc with the one at HEAD, and fails when a full path is exempted
 * from a readability rule that HEAD did not already exempt it from. A level below error
 * counts as exempt, and so does `on`, which takes the rule's default level. Globs are left
 * alone, since a folder-wide override is a policy written on purpose. Comparing with HEAD
 * holds a change back before it is committed; once committed, an exemption is the baseline.
 *
 * Not covered: suppression comments in code, and an override that disables the linter.
 *
 * Run by program-checks.mjs (`npm run audit:exemptions`); this module does nothing run on its own.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ROOT } from './programs.mjs';

const CONFIG = 'biome.jsonc';

const READABILITY_RULES = [
  'noExcessiveCognitiveComplexity',
  'useMaxParams',
  'noExcessiveLinesPerFunction',
  'noNestedTernary',
];

const EXEMPTING_LEVELS = new Set(['off', 'on', 'info', 'warn']);

const isGlob = (entry) => /[*!]/.test(entry);

const levelOf = (setting) => (typeof setting === 'string' ? setting : setting?.level);

/** The parsed config, or the reason it could not be read. */
function configFrom(text) {
  const { config, error } = ts.parseConfigFileTextToJson(CONFIG, text);
  if (error) return { error: ts.flattenDiagnosticMessageText(error.messageText, '\n') };
  return { config };
}

/** Every `path → rule` pair the config exempts by full path. */
function exemptionsIn(config) {
  const found = new Set();
  for (const override of config.overrides ?? []) {
    const groups = Object.values(override.linter?.rules ?? {});
    const exempted = READABILITY_RULES.filter((rule) =>
      groups.some((group) => EXEMPTING_LEVELS.has(levelOf(group?.[rule]))),
    );
    for (const entry of override.includes ?? []) {
      if (isGlob(entry)) continue;
      for (const rule of exempted) found.add(`${entry} → ${rule}`);
    }
  }
  return found;
}

const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The config's text at HEAD: null when nothing is committed yet or HEAD has no such file,
 * and an error when git cannot be read at all.
 */
function configTextAtHead() {
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    return { error: `git cannot be read here (${error.message.split('\n')[0]})` };
  }
  try {
    return { text: git(['show', `HEAD:${CONFIG}`]) };
  } catch {
    return { text: null };
  }
}

const failed = (reason) => ({ passed: false, report: `❌ lint-exemptions: ${reason}` });

function run() {
  const atHead = configTextAtHead();
  if (atHead.error) return failed(atHead.error);
  if (atHead.text === null) {
    return { passed: true, report: `✅ lint-exemptions: no ${CONFIG} at HEAD to compare with` };
  }
  const before = configFrom(atHead.text);
  if (before.error) return failed(`${CONFIG} at HEAD does not parse: ${before.error}`);
  const now = configFrom(readFileSync(join(ROOT, CONFIG), 'utf8'));
  if (now.error) return failed(`${CONFIG} does not parse: ${now.error}`);

  const exemptedBefore = exemptionsIn(before.config);
  const added = [...exemptionsIn(now.config)].filter((exemption) => !exemptedBefore.has(exemption));
  if (added.length === 0) {
    return {
      passed: true,
      report: '✅ lint-exemptions: no file newly exempted from a readability rule',
    };
  }
  const lines = added.map((exemption) => `  ${exemption}`);
  const summary = `\n❌ lint-exemptions: ${added.length} new exemption(s) by name in ${CONFIG}. Reshape the file until it meets the rule. A function that truly cannot meet it takes a biome-ignore with its reason, once the user agrees.`;
  return { passed: false, report: [...lines, summary].join('\n') };
}

export const lintExemptions = { name: 'lint-exemptions', run };
