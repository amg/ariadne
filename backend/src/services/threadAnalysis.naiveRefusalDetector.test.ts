import { describe, expect, it } from 'vitest';
import { naiveRefusalDetector } from './threadAnalysis/messageTransformer/naiveRefusalDetector';

/**
 * The naive refusal detector's matrix: every seeded marker plus the
 * normalization variants a provider realistically emits, against
 * legitimate rewrites that must stay clean. Refusal wording is a closed,
 * provider-stable class, so each positive here is boilerplate drawn from
 * an observed refusal or its canonical family — never content meaning.
 */

const SEED_REFUSAL = "I can't assist with this request.";

describe('naiveRefusalDetector — seeded markers', () => {
  it('flags the observed refusal from thread 1c36412d', () => {
    expect(naiveRefusalDetector(SEED_REFUSAL)).toBe(true);
    expect(naiveRefusalDetector(`${SEED_REFUSAL} Something more.`)).toBe(true);
  });

  it('flags the canonical family siblings', () => {
    expect(naiveRefusalDetector('I cannot assist with this request')).toBe(true);
    expect(naiveRefusalDetector("I can't assist with that request.")).toBe(true);
    expect(naiveRefusalDetector("I can't help with this request!")).toBe(true);
    expect(naiveRefusalDetector("I'm unable to assist with this request")).toBe(true);
  });

  it('flags refusals embedded inside surrounding content', () => {
    // A refusal mid-sentence inside otherwise-legitimate text is still a
    // refusal: the rewrite must not carry boilerplate anywhere.
    expect(
      naiveRefusalDetector(
        "Sure, happy to help — but I can't assist with this request, sorry about that.",
      ),
    ).toBe(true);
  });
});

describe('naiveRefusalDetector — normalization variants', () => {
  it('matches regardless of case', () => {
    expect(naiveRefusalDetector("I CAN'T ASSIST WITH THIS REQUEST")).toBe(true);
    expect(naiveRefusalDetector('i CaNnOt aSsIsT wItH tHiS rEqUeSt')).toBe(true);
  });

  it('treats contractions and their expansions as the same marker', () => {
    expect(naiveRefusalDetector("I can't assist with this request.")).toBe(true);
    expect(naiveRefusalDetector('I cannot assist with this request.')).toBe(true);
    expect(naiveRefusalDetector("I'm unable to assist with this request.")).toBe(true);
    expect(naiveRefusalDetector('I am unable to assist with this request.')).toBe(true);
  });

  it('survives stray punctuation and markup around the marker', () => {
    expect(naiveRefusalDetector('I can not assist with **this request**, I am afraid.')).toBe(true);
    expect(naiveRefusalDetector("I can't assist with this request—apologies!")).toBe(true);
  });
});

describe('naiveRefusalDetector — legitimate rewrites stay clean', () => {
  it('passes real self-contained rewordings', () => {
    expect(naiveRefusalDetector("What's the weight lifting record for a woman and a man?")).toBe(
      false,
    );
    expect(
      naiveRefusalDetector('Should I pack warm clothes for the Southern Hemisphere in July?'),
    ).toBe(false);
    expect(naiveRefusalDetector('How do I keep basil alive indoors?')).toBe(false);
  });

  it('passes refusals of a different class (not provider boilerplate)', () => {
    // A model declining in its own words is not the closed boilerplate
    // class; the detector stays silent rather than guessing at meaning.
    expect(naiveRefusalDetector("I can't find my keys anywhere right now.")).toBe(false);
    expect(naiveRefusalDetector("I don't know the answer to that one.")).toBe(false);
  });

  it('passes mentions of assisting that carry no refusal', () => {
    expect(naiveRefusalDetector('You can ask the assistant to assist with this request.')).toBe(
      false,
    );
    expect(naiveRefusalDetector('I can help with this request if you give me more detail.')).toBe(
      false,
    );
  });

  it('passes empty and whitespace output', () => {
    expect(naiveRefusalDetector('')).toBe(false);
    expect(naiveRefusalDetector('   \n\t ')).toBe(false);
  });
});
