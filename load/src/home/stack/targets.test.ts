import { describe, expect, it } from 'vitest';
import { TargetRefused, parseTarget } from './targets.ts';

describe('parseTarget', () => {
  it('accepts dev', () => {
    expect(parseTarget('dev')).toEqual({ kind: 'dev' });
  });

  it.each(['smoke', 'step10', 'step50', 'step100', 'step-prod'])(
    'accepts the aws-prod step %s',
    (step) => {
      expect(parseTarget(step)).toEqual({ kind: 'aws-prod', step });
    },
  );

  it.each(['prod', 'production', 'home-prod', 'staging'])('refuses %s by name', (name) => {
    expect(() => parseTarget(name)).toThrow(TargetRefused);
    expect(() => parseTarget(name)).toThrow(/never load targets/);
  });

  it.each(['', 'Dev', 'dev ', 'https://ari.kuro-void.com', 'localhost'])(
    'refuses the unknown name "%s"',
    (name) => {
      expect(() => parseTarget(name)).toThrow(/not a known load target/);
    },
  );
});
