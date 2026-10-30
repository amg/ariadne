import type { DisplayRow, HandoverProgress, RestoredDraft } from '@/components/chat/types';
import { ArrowDown } from 'lucide-react';
import { isRunning } from '../isRunning';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import type { ChatViewStatus, UnansweredArrival } from './types';
import { useStickToBottom } from './useStickToBottom';

type ChatViewProps = {
  rows: DisplayRow[];
  status: ChatViewStatus;
  errorMessage?: string | null;
  /**
   * The thread's last message is an arrival with no reply; the notice
   * offers its retry. Null when no arrival waits on one.
   */
  unansweredArrival?: UnansweredArrival | null;
  /** A failed submit's draft; restoring puts it back in the input. */
  restoredDraft?: RestoredDraft | null;
  onSend: (content: string) => void;
  onStop: () => void;
  /** Regenerates the last exchange server-side (works on stuck/failed replies). */
  onRetryLast: () => void;
  /** Persists an edit of the thread's last message; rejects empty content. */
  onEditMessage: (messageId: string, content: string) => Promise<boolean>;
  /**
   * The arrival the gate paused on, waiting for the user to choose where it
   * continues; null when nothing waits. The input stays locked meanwhile.
   */
  pausedMessageId: string | null;
  /** How far moving the paused arrival into a fresh chat has got. */
  handover: HandoverProgress;
  onContinueHere: () => void;
  onStartNewChat: () => void;
};

export default function ChatView({
  rows,
  status,
  errorMessage,
  unansweredArrival,
  restoredDraft,
  onSend,
  onStop,
  onRetryLast,
  onEditMessage,
  pausedMessageId,
  handover,
  onContinueHere,
  onStartNewChat,
}: ChatViewProps) {
  const busy = isRunning(status);

  // Always show thinking bubble during "submitted" phase (while drift evaluation runs).
  // During "streaming", only show if no assistant row with content exists yet.
  const hasVisibleAssistant = rows.some(
    (row) =>
      row.streaming &&
      (row.message.content.trim().length > 0 || (row.reasoning && row.reasoning.trim().length > 0)),
  );
  const needsPendingBubble =
    status === 'submitted' || (status === 'streaming' && !hasVisibleAssistant);

  // Follow the tail while pinned near it, never fight the user.
  const { viewportRef, atBottom, scrollToBottom } = useStickToBottom({
    triggers: [rows, needsPendingBubble],
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MessageList
        viewportRef={viewportRef}
        rows={rows}
        status={status}
        busy={busy}
        needsPendingBubble={needsPendingBubble}
        pausedMessageId={pausedMessageId}
        handover={handover}
        onRetryLast={onRetryLast}
        onEditMessage={onEditMessage}
        onContinueHere={onContinueHere}
        onStartNewChat={onStartNewChat}
      />
      {rows.length > 0 && !atBottom ? (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Jump to latest message"
          className="absolute bottom-20 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-background/90 p-2 text-muted-foreground shadow-md backdrop-blur transition-colors hover:text-foreground"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
      <Composer
        busy={busy}
        paused={pausedMessageId !== null}
        restoredDraft={restoredDraft}
        unansweredArrival={unansweredArrival}
        errorMessage={errorMessage}
        onSend={onSend}
        onStop={onStop}
        onRetryLast={onRetryLast}
        onSent={scrollToBottom}
      />
    </div>
  );
}
