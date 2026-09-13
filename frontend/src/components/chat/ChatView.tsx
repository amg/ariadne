import { MessageMetaRow } from '@/components/metadata';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Message, MessageUsage } from '@/services/api';
import { chatStatusText } from '@/services/utils';
import { ArrowDown, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import MarkdownContent from './MarkdownContent';
import ThinkingIndicator from './ThinkingIndicator';

/** A single bubble line plus its metadata row (settled or streaming). */
export interface DisplayRow {
  id: string;
  message: Message;
  usage: MessageUsage | null;
  /** True while this assistant row is still being streamed. */
  streaming: boolean;
}

type Props = {
  rows: DisplayRow[];
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  errorMessage?: string | null;
  onSend: (content: string) => void;
  onStop: () => void;
};

/** How close to the bottom counts as "following" new content. */
const FOLLOW_BOTTOM_PX = 80;

export default function ChatView({ rows, status, errorMessage, onSend, onStop }: Props) {
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';
  // While waiting for the reply (submitted) there is no assistant row yet
  // in useChat state — append a thinking bubble so loading is visible.
  const needsPendingBubble = busy && !rows.some((row) => row.streaming);

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
    if (viewport && followBottom.current) viewport.scrollTop = viewport.scrollHeight;
  }, [rows]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mx-auto flex h-full w-full min-h-0 min-w-0 max-w-[900px] flex-col">
        <ScrollArea viewportRef={viewportRef} className="min-h-0 flex-1 p-4">
          <div className="flex flex-col gap-4">
            {rows.map(({ id, message, usage, streaming }) => (
              <div key={id} className="flex min-w-0 max-w-[70%] flex-col">
                <div
                  className={`max-w-full rounded-lg p-3 ${
                    message.role === 'user'
                      ? 'self-end whitespace-pre-wrap break-words bg-primary text-primary-foreground'
                      : 'min-w-0 self-start bg-muted text-foreground'
                  }`}
                >
                  {message.role === 'assistant' ? (
                    streaming && !message.content ? (
                      <ThinkingIndicator />
                    ) : (
                      <MarkdownContent content={message.content} streaming={streaming} />
                    )
                  ) : (
                    message.content
                  )}
                </div>
                {message.role === 'assistant' ? (
                  <MessageMetaRow
                    usage={usage}
                    status={streaming ? chatStatusText(status) : undefined}
                    showLatency={!streaming}
                  />
                ) : null}
              </div>
            ))}
            {needsPendingBubble ? (
              <div className="flex min-w-0 max-w-[70%] flex-col">
                <div className="self-start rounded-lg bg-muted p-3 text-foreground">
                  <ThinkingIndicator />
                </div>
                <MessageMetaRow usage={null} status={chatStatusText(status)} showLatency={false} />
              </div>
            ) : null}
          </div>
        </ScrollArea>
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
        <div className="border-t bg-background p-4">
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
    </div>
  );
}
