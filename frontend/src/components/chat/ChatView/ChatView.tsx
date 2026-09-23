import { MessageMetaRow } from '@/components/metadata';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { chatStatusText } from '@/services/utils';
import { ArrowDown, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ThinkingIndicator from '../ThinkingIndicator';
import { MessageRow } from './MessageRow';
import type { ChatViewStatus, DisplayRow } from './types';

const FOLLOW_BOTTOM_PX = 80;

type ChatViewProps = {
  rows: DisplayRow[];
  status: ChatViewStatus;
  errorMessage?: string | null;
  onSend: (content: string) => void;
  onStop: () => void;
  /** Regenerates the last exchange server-side (works on stuck/failed replies). */
  onRetryLast: () => void;
  /** Persists an edit of the thread's last message; rejects empty content. */
  onEditMessage: (messageId: string, content: string) => void;
};

export default function ChatView({
  rows,
  status,
  errorMessage,
  onSend,
  onStop,
  onRetryLast,
  onEditMessage,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

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

  // Chase growth that happens without a rows change (code blocks, images).
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = viewport?.firstElementChild;
    if (!viewport || !(content instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
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
    if (!input.trim() || busy) return;
    onSend(input.trim());
    setInput('');
    // Always show the user's own message, even after scrolling up.
    scrollToBottom();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={viewportRef} className="scrollbar-slim min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full min-w-0 max-w-[900px] flex-col">
          <div className="flex flex-col gap-4 py-4">
            {rows.map((row, index) => (
              <MessageRow
                key={row.id}
                row={row}
                isLast={index === rows.length - 1}
                isLastUser={row.message.role === 'user' && row.id === lastUserId}
                busy={busy}
                status={status}
                onRetryLast={onRetryLast}
                onEditMessage={onEditMessage}
              />
            ))}
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
        {errorMessage ? <p className="mb-2 text-sm text-red-400">{errorMessage}</p> : null}
        <form className="flex gap-2" onSubmit={handleSubmit}>
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type your message..."
            className="flex-1"
            autoFocus
          />
          {busy ? (
            <Button type="button" size="icon" variant="destructive" onClick={onStop}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
