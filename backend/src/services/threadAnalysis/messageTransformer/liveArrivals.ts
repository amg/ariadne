import type { Message } from '@db/types';
import type { LiveArrival } from '../types';

/**
 * One arrival per user message in thread order, with its adjacent assistant
 * reply, numbered on from the live arrivals that come before the messages.
 */
export function liveArrivalsOf({
  messages,
  arrivalsBefore,
}: {
  messages: readonly Message[];
  arrivalsBefore: number;
}) {
  const arrivals: LiveArrival[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const next = messages[i + 1];
    arrivals.push({
      turnNumber: arrivalsBefore + arrivals.length + 1,
      userMessage: message,
      assistantReply: next && next.role === 'assistant' ? next : null,
    });
  }
  return arrivals;
}
