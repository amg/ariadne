import { MessageMetaRow } from '@/components/metadata';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { chatStatusText } from '@/services/utils';
import { ArrowDown, Send, Square } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import ThinkingIndicator from '../ThinkingIndicator';
import { DriftChoice } from './DriftChoice';
import { MessageRow } from './MessageRow';
import type {
  ChatViewStatus,
  DisplayRow,
  HandoverProgress,
  RestoredDraft,
  UnansweredArrival,
} from './types';

const FOLLOW_BOTTOM_PX = 80;

function BoundaryLine({ row }: { row: DisplayRow }) {
  const isFire = row.message.role === 'user' && row.verdict?.verdict === 'fire';
  if (!isFire) return null;
  const isFireSlow = row.verdict?.fireChannel === 'slow';
  return (
    <div className="flex items-center gap-4 py-2">
      <hr
        className={`flex-1 border-t border-dashed ${isFireSlow ? 'border-green-500' : 'border-purple-500'}`}
      />
      <span
        className={`text-xs font-semibold uppercase tracking-wider ${isFireSlow ? 'text-green-500' : 'text-purple-500'}`}
      >
        {isFireSlow ? 'Slow Drift' : 'Topic Shift'}
      </span>
      <hr
        className={`flex-1 border-t border-dashed ${isFireSlow ? 'border-green-500' : 'border-purple-500'}`}
      />
    </div>
  );
}

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

const UNANSWERED_ARRIVAL_COPY: Record<UnansweredArrival, string> = {
  pending: 'This message is still being checked.',
  cleared: 'This message is checked and ready for a reply.',
  failed: 'This message could not be checked.',
};

/**
 * The calm line over the composer while an arrival owes its reply: the
 * message stays, and a retry waits on the same judgment again. It sits
 * where an error line sits, but never shouts.
 */
function UnansweredArrivalNotice({
  kind,
  onRetry,
}: { kind: UnansweredArrival; onRetry: () => void }) {
  return (
    <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
      {UNANSWERED_ARRIVAL_COPY[kind]}
      <button
        type="button"
        onClick={onRetry}
        className="underline underline-offset-2 transition-colors hover:text-foreground"
      >
        retry
      </button>
    </p>
  );
}

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
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const paused = pausedMessageId !== null;

  // The draft never dies on a failed submit: it returns to the input, and
  // recovery is a resend.
  useEffect(() => {
    if (!restoredDraft) return;
    // External system sync (the registry's failed-submit notification lands
    // in state, this writes it into the DOM input and focuses it) — the only
    // shape that can restore AND focus a live input element.
    // eslint-disable-next-line react/set-state-in-effect
    setInput(restoredDraft.text);
    inputRef.current?.focus();
  }, [restoredDraft]);

  // Always show thinking bubble during "submitted" phase (while drift evaluation runs).
  // During "streaming", only show if no assistant row with content exists yet.
  const hasVisibleAssistant = rows.some(
    (row) =>
      row.streaming &&
      (row.message.content.trim().length > 0 || (row.reasoning && row.reasoning.trim().length > 0)),
  );
  const needsPendingBubble =
    status === 'submitted' || (status === 'streaming' && !hasVisibleAssistant);

  // The last user prompt is the only editable row — even when a (possibly
  // failed) assistant reply follows it.
  const lastUserId = [...rows].reverse().find((row) => row.message.role === 'user')?.id ?? null;

  // --- Scrolling: follow the tail while pinned near it, never fight the user. ---
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleScroll = () => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const near = distance <= FOLLOW_BOTTOM_PX;
      followBottom.current = near;
      setAtBottom(near);
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  // Keep the tail visible when rows change (new message, stream deltas).
  // `rows` is the intentional trigger — the effect itself only reads refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is the trigger, see above
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followBottom.current) {
      // Use RAF to ensure DOM has updated before scrolling
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
    }
  }, [rows, needsPendingBubble]);

  // Chase growth that happens without a rows change (code blocks, images),
  // and keep the tail visible when the pane shrinks (on-screen keyboard).
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = viewport?.firstElementChild;
    if (!viewport || !(content instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followBottom.current = true;
    viewport.scrollTop = viewport.scrollHeight;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim() || busy || paused) return;
    onSend(input.trim());
    setInput('');
    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    // Always show the user's own message, even after scrolling up.
    scrollToBottom();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter inserts a newline (default behavior)
    if (event.key === 'Enter' && event.shiftKey) {
      return;
    }
    // Enter alone sends the message
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!input.trim() || busy || paused) return;
      onSend(input.trim());
      setInput('');
      // Reset textarea height
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
      }
      scrollToBottom();
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setInput(value);
    // Auto-grow the textarea up to max-h-[120px] (~5 lines)
    const textarea = event.target;
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 120);
    textarea.style.height = `${newHeight}px`;
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={viewportRef}
        className="scrollbar-slim min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex w-full min-w-0 max-w-[900px] flex-col">
          <div className="flex flex-col gap-4 py-4 px-4">
            {rows.map((row, index) => {
              return (
                <Fragment key={row.id}>
                  <BoundaryLine row={row} />
                  <MessageRow
                    row={row}
                    isLast={index === rows.length - 1}
                    isLastUser={row.message.role === 'user' && row.id === lastUserId}
                    busy={busy}
                    status={status}
                    onRetryLast={onRetryLast}
                    onEditMessage={onEditMessage}
                  />
                  {row.id === pausedMessageId ? (
                    <DriftChoice
                      busy={busy || handover !== 'idle'}
                      handover={handover}
                      onContinueHere={onContinueHere}
                      onStartNewChat={onStartNewChat}
                    />
                  ) : null}
                </Fragment>
              );
            })}
            {needsPendingBubble ? (
              <div className="flex min-w-0 max-w-[85%] flex-col self-start md:max-w-[75%]">
                <div className="self-start rounded-lg bg-muted p-3 text-foreground">
                  <ThinkingIndicator />
                </div>
                <MessageMetaRow
                  className="mt-1 self-end"
                  usage={null}
                  status={chatStatusText(status)}
                  showLatency={false}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
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
      <div className="mx-auto w-full min-w-0 max-w-[900px] border-t bg-background p-4">
        {unansweredArrival ? (
          <UnansweredArrivalNotice kind={unansweredArrival} onRetry={onRetryLast} />
        ) : errorMessage ? (
          <p className="mb-2 text-sm text-red-400">{errorMessage}</p>
        ) : null}
        <form className="flex gap-2" onSubmit={handleSubmit}>
          <Textarea
            ref={inputRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              paused ? 'Choose where the last message continues first' : 'Type your message...'
            }
            className="flex-1 resize-none"
            rows={1}
            autoFocus
          />
          {busy ? (
            <Button type="button" size="icon" variant="destructive" onClick={onStop}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim() || paused}>
              <Send className="h-4 w-4" />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
