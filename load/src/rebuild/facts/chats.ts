import { isChat } from '../../records/index.ts';
import { requestsOf } from '../runData/index.ts';
import type { RunData } from '../types.ts';
import { downWindowsOf, insideAnyOf } from './slices.ts';

/**
 * The generators' chats, by the replies that streamed and the chats the
 * gate paused, and the API's exchanges, by those that sent a first token
 * and those it paused. A chat or exchange that began inside a window a slice
 * was down is left out of both sides.
 */
export function chatCountsOf(data: RunData) {
  const down = insideAnyOf(downWindowsOf(data));
  const allChats = requestsOf(data).filter(isChat);
  const chats = allChats.filter((line) => !down(line.startedAt));
  const exchanges = data.exchanges?.filter((line) => !down(line.arrivedAt)) ?? null;
  const whole = data.slices.every(({ requests }) => requests !== null);
  return {
    generators: whole
      ? {
          streamed: chats.filter((line) => line.outcome === 'streamed').length,
          paused: chats.filter((line) => line.outcome === 'paused').length,
        }
      : null,
    api:
      exchanges === null
        ? null
        : {
            streamed: exchanges.filter((line) => line.firstTokenAfterMs !== null).length,
            paused: exchanges.filter((line) => line.outcome === 'paused').length,
          },
    leftOut: {
      chats: allChats.length - chats.length,
      exchanges: (data.exchanges?.length ?? 0) - (exchanges?.length ?? 0),
    },
  };
}
