/** The aws-prod steps a run may target. */
const AWS_PROD_STEPS = ['smoke', 'step10', 'step50', 'step100', 'step-prod'] as const;

type AwsProdStep = (typeof AWS_PROD_STEPS)[number];

/** Where a run's load goes: dev on this machine, or a raised aws-prod step. */
type Target = { kind: 'dev' } | { kind: 'aws-prod'; step: AwsProdStep };

/** Production on the home machine, which serves real users and spends real money. */
const HOME_PRODUCTION_NAMES = ['prod', 'production', 'home-prod', 'staging'];

export class TargetRefused extends Error {}

/** The target a name stands for. Production on the home machine and every name the harness does not know are refused. */
export function parseTarget(name: string): Target {
  if (name === 'dev') return { kind: 'dev' };
  const step = AWS_PROD_STEPS.find((known) => known === name);
  if (step !== undefined) return { kind: 'aws-prod', step };
  if (HOME_PRODUCTION_NAMES.includes(name)) {
    throw new TargetRefused(
      `"${name}" is refused: production and staging on the home machine are never load targets.`,
    );
  }
  throw new TargetRefused(
    `"${name}" is not a known load target. Known targets: dev, ${AWS_PROD_STEPS.join(', ')}.`,
  );
}
