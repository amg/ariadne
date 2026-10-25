/**
 * What users talk about. Each message carries the mock's `TOPIC:<name>`
 * marker, which gives messages on one topic nearby embeddings, so the
 * Drift gate lets a conversation run and fires when it changes topic.
 */
const TOPICS: Record<string, string[]> = {
  sourdough: [
    'How do I keep a sourdough starter alive while travelling?',
    'Does feeding it rye flour change how sour the bread gets?',
    'What hydration would you start with for a first loaf?',
    'How long should the bulk ferment run in a warm kitchen?',
    'Why does my crust come out pale even at high heat?',
  ],
  hiking: [
    'Which layers should I pack for a winter day hike?',
    'How do I tell if a mountain trail is too icy to continue?',
    'What is a sensible pace for a beginner on steep ground?',
    'How much water should I carry for six hours in the hills?',
    'Are trekking poles worth it on the way down?',
  ],
  espresso: [
    'Why does my espresso taste sour even with fresh beans?',
    'How fine should I grind for a double shot?',
    'Does the water temperature matter much for a light roast?',
    'How do I steam milk without big bubbles?',
    'How often should I descale a home machine?',
  ],
};
const TOPIC_NAMES = Object.keys(TOPICS);

/** The share of messages that change the subject, which the Drift gate should pause. */
export const OFF_TOPIC_SHARE = 0.1;

/** The topic a user starts on; the same user number always gets the same topic. */
export function topicOf(userNumber: number) {
  return TOPIC_NAMES[userNumber % TOPIC_NAMES.length] ?? 'sourdough';
}

export function otherTopicThan(topic: string) {
  const others = TOPIC_NAMES.filter((name) => name !== topic);
  return others[Math.floor(Math.random() * others.length)] ?? topic;
}

/** The message a user sends on `topic` at `turn`, cycling through that topic's messages. */
export function messageOn(topic: string, turn: number) {
  const messages = TOPICS[topic] ?? [];
  return `${messages[turn % messages.length] ?? 'Tell me more.'} TOPIC:${topic}`;
}
