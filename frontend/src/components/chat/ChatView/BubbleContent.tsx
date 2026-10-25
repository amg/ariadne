import type { Message } from '@/services/api';
import { RefreshCw } from 'lucide-react';
import MarkdownContent from '../MarkdownContent';
import ThinkingIndicator from '../ThinkingIndicator';
import { ReasoningBlock } from './ReasoningBlock';

/** Bubble body: thinking state, stuck-empty retry card, or rendered content. */
export function BubbleContent({
  message,
  streaming,
  busy,
  onRetryLast,
  reasoning,
}: {
  message: Pick<Message, 'role' | 'content'>;
  streaming: boolean;
  busy: boolean;
  onRetryLast: () => void;
  reasoning?: string | null;
}) {
  if (message.role !== 'assistant') return <>{message.content}</>;

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
