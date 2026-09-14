import { MessageMetaRow } from '@/components/metadata';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Message, MessageUsage } from '@/services/api';
import { chatStatusText } from '@/services/utils';
import { ArrowDown, Pencil, RefreshCw, Send, Square } from 'lucide-react';
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
  /** Reasoning content (thinking) if available */
  reasoning?: string | null;
}

type Props = {
  rows: DisplayRow[];
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  errorMessage?: string | null;
  onSend: (content: string) => void;
  onStop: () => void;
  /** Regenerates the last exchange server-side (works on stuck/failed replies). */
  onRetryLast: () => void;
  /** Persists an edit of the thread's last message; rejects empty content. */
  onEditMessage: (messageId: string, content: string) => void;
};

/** How close to the bottom counts as "following" new content. */
const FOLLOW_BOTTOM_PX = 80;

/** Per-row edit + retry affordances; extracted to keep ChatView shallow. */
function MessageRow({
  row,
  isLast,
  isLastUser,
  busy,
  status,
  onRetryLast,
  onEditMessage,
}: {
  row: DisplayRow;
  isLast: boolean;
  /** True on the thread's final user message — the only editable row. */
  isLastUser: boolean;
  busy: boolean;
  status: Props['status'];
  onRetryLast: () => void;
  onEditMessage: (messageId: string, content: string) => void;
}) {
  const { message, usage, streaming, reasoning } = row;
  // null = not editing; only the last user row exposes the affordance anyway.
  const [draft, setDraft] = useState<string | null>(null);
  const isEditing = draft !== null;
  // Settled assistant rows with no text: a failed/stuck exchange. They get an
  // explicit retry affordance instead of a blank bubble.
  const isStuckEmpty = message.role === 'assistant' && !streaming && message.content === '';
  // The assistant reply itself is never edited — retry is its recovery path;
  // prompts are edited, and saving continues the exchange from the new text.
  const showEdit = message.role === 'user' && isLastUser && !busy && !isEditing;
  const showRetry = message.role === 'assistant' && isLast && !busy && !isStuckEmpty;

  return (
    <div className="flex min-w-0 max-w-[70%] flex-col">
      {isEditing ? (
        <EditBox
          draft={draft ?? ''}
          onDraftChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={(content) => {
            onEditMessage(message.id, content);
            setDraft(null);
          }}
        />
      ) : message.role === 'assistant' ? (
        <div className="min-w-0 max-w-full self-start rounded-lg bg-muted p-3 text-foreground">
          <BubbleContent
            message={message}
            streaming={streaming}
            busy={busy}
            onRetryLast={onRetryLast}
            reasoning={reasoning}
          />
        </div>
      ) : (
        <div className="max-w-full self-end whitespace-pre-wrap break-words rounded-lg bg-primary p-3 text-primary-foreground">
          {message.content}
        </div>
      )}
      {message.role === 'assistant' ? (
        <MessageMetaRow
          className="mt-1 self-end"
          usage={usage}
          status={streaming ? chatStatusText(status) : undefined}
          showLatency={!streaming}
          action={
            showRetry ? (
              <button
                type="button"
                onClick={onRetryLast}
                title="Retry generation"
                className="ml-1 flex items-end gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                retry
              </button>
            ) : null
          }
        />
      ) : null}
      {/* Edit controls, only while the exchange is idle. */}
      {showEdit ? (
        <div className="mt-1 flex items-center gap-2 self-end">
          <button
            type="button"
            onClick={() => setDraft(message.content)}
            title="Edit message"
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
            edit
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Bubble body: thinking state, stuck-empty retry card, or rendered content. */
function BubbleContent({
  message,
  streaming,
  busy,
  onRetryLast,
  reasoning,
}: {
  message: Message;
  streaming: boolean;
  busy: boolean;
  onRetryLast: () => void;
  reasoning?: string | null;
}) {
  if (message.role !== 'assistant') return message.content;

  // Show reasoning during thinking phase, even before text starts
  const hasReasoning = reasoning && reasoning.trim().length > 0;
  const hasContent = message.content && message.content.trim().length > 0;

  // Only show simple thinking indicator if NO reasoning and NO content
  if (streaming && !hasContent && !hasReasoning) return <ThinkingIndicator />;

  // Show "No reply generated" only when there's NEITHER content NOR reasoning, and stream ended
  if (!hasContent && !hasReasoning && !busy) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4" />
        No reply generated
        <button
          type="button"
          onClick={onRetryLast}
          className="underline underline-offset-2 transition-colors hover:text-foreground"
        >
          retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hasReasoning && (
        <ReasoningBlock reasoning={reasoning} isThinking={streaming && !hasContent} />
      )}
      {hasContent && <MarkdownContent content={message.content} streaming={streaming} />}
    </div>
  );
}

/** Collapsible reasoning/thinking block */
function ReasoningBlock({ reasoning, isThinking }: { reasoning: string; isThinking?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="rounded-md border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          <svg
            className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="Expand or collapse thinking"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="flex items-center gap-1.5">
            Thinking
            {isThinking && <ThinkingIndicator />}
          </span>
        </span>
        <span className="text-xs opacity-60">
          {isExpanded ? 'Hide' : `Show (${reasoning.length} chars)`}
        </span>
      </button>
      {isExpanded && (
        <div className="max-h-96 overflow-y-auto border-t border-border bg-muted/20 px-3 py-3 text-sm italic text-muted-foreground">
          <MarkdownContent content={reasoning} streaming={false} />
        </div>
      )}
    </div>
  );
}

/** Inline editor for the last user message. Saving an empty draft is impossible. */
function EditBox({
  draft,
  onDraftChange,
  onCancel,
  onSave,
}: {
  draft: string;
  onDraftChange: (next: string) => void;
  onCancel: () => void;
  /** Receives the trimmed draft; guaranteed non-empty by the Save guard. */
  onSave: (content: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Focus on open; an effect (not the autoFocus attribute) keeps it screen-reader friendly.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const save = () => {
    const content = draft.trim();
    if (!content) return;
    onSave(content);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        rows={4}
        className="w-full resize-y rounded-lg border bg-background p-3 text-sm text-foreground focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!draft.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

export default function ChatView({
  rows,
  status,
  errorMessage,
  onSend,
  onStop,
  onRetryLast,
  onEditMessage,
}: Props) {
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  // While waiting for the reply (submitted) there is no assistant row yet
  // in useChat state — append a thinking bubble so loading is visible.
  const needsPendingBubble = busy && !rows.some((row) => row.streaming);

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
              <div className="flex min-w-0 max-w-[70%] flex-col">
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
