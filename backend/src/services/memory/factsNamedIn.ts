/**
 * Runs of capitalised words: "Kuro", "New York". Fact sentences are
 * written by the extractor in standard English, so names come out
 * capitalised even when the user typed them in lowercase.
 */
const CAPITALISED_RUN = /\p{Lu}[\p{L}\p{N}\p{M}'’-]*(?:\s+\p{Lu}[\p{L}\p{N}\p{M}'’-]*)*/gu;
const POSSESSIVE_ENDING = /['’]s$/u;

/**
 * The names a Fact sentence mentions, lowercased. The opening word is
 * capitalised only because it opens the sentence, so it does not count.
 */
export function namesInFact(sentence: string): string[] {
  const names: string[] = [];
  for (const match of sentence.matchAll(CAPITALISED_RUN)) {
    const words = match[0].split(/\s+/);
    if (match.index === 0) words.shift();
    const name = words.join(' ').replace(POSSESSIVE_ENDING, '');
    if (name !== '') names.push(name.toLowerCase());
  }
  return names;
}

function escapedForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `name` sits in `text` as whole words, not inside a longer word. */
function mentionsName(text: string, name: string): boolean {
  const words = name.split(' ').map(escapedForRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${words}(?![\\p{L}\\p{N}\\p{M}])`, 'u').test(text);
}

/**
 * The Fact sentences that name someone or something the text mentions,
 * in the order given. Case does not matter on either side.
 */
export function factsNamedIn(sentences: readonly string[], text: string): string[] {
  const lowered = text.toLowerCase();
  return sentences.filter((sentence) =>
    namesInFact(sentence).some((name) => mentionsName(lowered, name)),
  );
}
