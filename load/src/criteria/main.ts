import { readFileSync } from 'node:fs';
import { limitsFor } from './limits.ts';

/**
 * Prints the limits a new run of a step records, as JSON:
 *   npm run limits --workspace=load -- <step> [<step configuration file>]
 *
 * The limits of a step that follows its size are worked out from the users
 * and share of chatters in its configuration, which is the JSON file the
 * run records as its config.
 *
 * A step with no limits yet prints null, and says so on stderr. A rebuild
 * of such a run names the missing limits and never passes it.
 */
const [step, configFile] = process.argv.slice(2);
if (step === undefined || step === '') {
  console.error('usage: limits <step> [<step configuration file>]');
  process.exit(2);
}
const config: unknown =
  configFile === undefined ? {} : JSON.parse(readFileSync(configFile, 'utf8'));
if (typeof config !== 'object' || config === null) {
  console.error(`${configFile} is not a JSON object`);
  process.exit(2);
}
const limits = limitsFor(step, Object.fromEntries(Object.entries(config)));
if (limits === null) console.error(`No limits are defined for "${step}" yet`);
console.log(JSON.stringify(limits));
