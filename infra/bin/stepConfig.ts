import { stepNamed } from '../config/steps.ts';

/**
 * Prints a step's whole configuration as JSON, for the run's record, with
 * the seed snapshot its database was restored from (null when it started
 * empty):
 *   tsx bin/stepConfig.ts <step> [seed snapshot]
 */
const [name, seedSnapshot] = process.argv.slice(2);
if (name === undefined) throw new Error('usage: stepConfig <step> [seed snapshot]');
const step = stepNamed(name);
console.log(
  JSON.stringify({
    ...step,
    database: {
      ...step.database,
      seedSnapshot: seedSnapshot === undefined || seedSnapshot === '' ? null : seedSnapshot,
    },
  }),
);
