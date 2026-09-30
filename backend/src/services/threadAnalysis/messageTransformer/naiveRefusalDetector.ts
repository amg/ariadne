/**
 * Minimal quality check on rewrite-model output: detects when the rewrite
 * model responded with a refusal ("I can't assist with this request…")
 * instead of the arrival's self-contained reading. Refusal wording is
 * provider-stable boilerplate — detectable by string markers without
 * interpreting meaning. Markers are added only from observed refusals
 * (seen in calibration or production), and each ships with a regression
 * test.
 */

interface RefusalMarker {
  /** The marker as it appears after normalization. */
  marker: string;
  /** The event that justified adding this marker; every marker carries
   * its source. */
  source: string;
}

/**
 * Normalize case, contractions, and stray punctuation so "can't" and
 * "cannot", and "**this request**" and "this request", all match the
 * same marker.
 */
const CONTRACTIONS: ReadonlyMap<string, string> = new Map([
  // The negation suffix 't expands to " not" while keeping the verb's
  // trailing letter ("can't" -> "can not", not "ca not").
  ["'t", ' not'],
  ['’t', ' not'],
  // The already-expanded form normalizes to the same two-word marker.
  ['cannot', 'can not'],
  ["'m", ' am'],
  ['’m', ' am'],
  ["'re", ' are'],
  ['’re', ' are'],
  ["'ve", ' have'],
  ['’ve', ' have'],
]);

function normalizeForRefusalMatch(text: string): string {
  let normalized = text.toLowerCase();
  for (const [contraction, expanded] of CONTRACTIONS) {
    normalized = normalized.split(contraction).join(expanded);
  }
  // Stray markup becomes a word separator, then runs collapse to single
  // spaces, so no decoration can break up a marker's word run.
  normalized = normalized.replace(/[^a-z0-9\s]+/g, ' ');
  return normalized.replace(/\s+/g, ' ').trim();
}

/**
 * Markers are deliberately full sentence cores so that legitimate
 * rewrites that merely mention "assist" or "request" cannot match.
 */
const REFUSAL_MARKERS: readonly RefusalMarker[] = [
  {
    marker: 'can not assist with this request',
    source: 'observed: 100-thread calibration, thread 1c36412d (Qwen model, DeepInfra)',
  },
  {
    marker: 'can not assist with that request',
    source: 'seeded: same boilerplate family as the observed marker (pointer-word variant)',
  },
  {
    marker: 'can not help with this request',
    source: 'seeded: same boilerplate family as the observed marker (help-verb variant)',
  },
  {
    marker: 'i am unable to assist with this request',
    source: 'seeded: same boilerplate family as the observed marker (unable-verb variant)',
  },
];

/** True when the rewrite output reads as a provider refusal rather than a rewrite. */
export function naiveRefusalDetector(rawText: string): boolean {
  const normalized = normalizeForRefusalMatch(rawText);
  return REFUSAL_MARKERS.some(({ marker }) => normalized.includes(marker));
}
