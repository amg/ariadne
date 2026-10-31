import { type Message, stopThreadExchange } from '@/services/api';
import { useChat } from '@ai-sdk/react';
import { useMemo } from 'react';
import ChatView from '../ChatView';
import { describeChatError, gateWaitOutcomeOf, getThreadChat } from './chatRegistry';
import { useChatActions } from './useChatActions';
import { useDroppedIds } from './useDroppedIds';
import { useHandover } from './useHandover';
import { useLiveReasoning } from './useLiveReasoning';
import { useThreadChatEvents } from './useThreadChatEvents';
import { mergeDisplayRows, pausedArrivalIdOrNull, unansweredArrivalOrNull } from './utils';

type ChatControllerProps = {
  threadId: string;
  rows: Message[];
  /** Whether the deployment runs Memory: a handover then saves the old chat's Facts first. */
  memory: boolean;
  /** Whether the Drift gate judges arrivals; with it off every arrival is clear. */
  arrivalsJudged: boolean;
  onSettle: () => void;
  /** Opens the fresh thread a paused arrival was moved to. */
  onHandedOver?: (threadId: string) => void;
};

/**
 * Owns the live AI exchange for one thread: the thread's registry chat
 * object, optimistic + streaming rows merged over the settled loader rows,
 * and send/stop. Renders the pure ChatView. (The page only wires router
 * glue.) The chat object outlives this view — unmounting never stops the
 * exchange, and remounting reattaches to the live or settled stream.
 */
export default function ChatController({
  threadId,
  rows,
  memory,
  arrivalsJudged,
  onSettle,
  onHandedOver,
}: ChatControllerProps) {
  // The chat object lives in the per-tab registry (module level), keyed by
  // thread; useChat attaches to it externally instead of owning one, so no
  // effect here can stop the exchange on unmount.
  const chat = useChat({ chat: getThreadChat(threadId) });

  const { droppedIds, dropIds } = useDroppedIds();
  const { messagesRef, reasoningCache } = useLiveReasoning(chat.messages);
  const { streamVerdict, restoredDraft } = useThreadChatEvents({ threadId, messagesRef, onSettle });

  // Filter out dropped and abandoned rows before merging with chat messages:
  // abandoned rows stay in the DB (their usage keeps tracking what the
  // thread burned), but never render.
  const visibleRows = useMemo(
    () => rows.filter((row) => !droppedIds.has(row.id) && !row.abandoned),
    [rows, droppedIds],
  );

  // The purple bubble: the transient verdict arrives through `onData` before
  // the reply grows, so the merge keys it to the arrival's optimistic row;
  // after settle the loader rows carry the persisted verdicts instead.
  const display = useMemo(
    () =>
      mergeDisplayRows({
        rows: visibleRows,
        chatMessages: chat.messages,
        status: chat.status,
        reasoningCache: reasoningCache.current,
        liveVerdict: streamVerdict,
      }),
    [visibleRows, chat.messages, chat.status, streamVerdict, reasoningCache],
  );

  const pausedMessageId = pausedArrivalIdOrNull({
    display,
    settledRows: visibleRows,
    status: chat.status,
  });

  // The chat object outlives this view, so a gate wait its last request
  // ended in is still known after a remount; a new request clears it.
  const gateWait = gateWaitOutcomeOf(chat.error);
  const unansweredArrival = unansweredArrivalOrNull({
    display,
    settledRows: visibleRows,
    status: chat.status,
    gateWait,
    arrivalsJudged,
  });

  const { handover, handoverError, startNewChat } = useHandover({
    threadId,
    memory,
    pausedMessageId,
    chat,
    onHandedOver,
    dropIds,
  });
  const { send, retryLast, editMessage } = useChatActions({
    threadId,
    chat,
    rows,
    reasoningCache,
    dropIds,
    onSettle,
  });

  return (
    <ChatView
      rows={display}
      status={chat.status}
      errorMessage={handoverError ?? describeChatError(chat.error)}
      unansweredArrival={unansweredArrival}
      restoredDraft={restoredDraft}
      onSend={send}
      onStop={() => {
        chat.stop();
        void stopThreadExchange(threadId).catch(() => {});
      }}
      onRetryLast={() => retryLast()}
      onEditMessage={editMessage}
      pausedMessageId={pausedMessageId}
      handover={handover}
      onContinueHere={() => retryLast(undefined, true)}
      onStartNewChat={() => void startNewChat()}
    />
  );
}
