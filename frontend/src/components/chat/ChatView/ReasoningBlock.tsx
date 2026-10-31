import { useState } from 'react';
import MarkdownContent from '../MarkdownContent';
import ThinkingIndicator from '../ThinkingIndicator';

/** Collapsible reasoning/thinking block */
export function ReasoningBlock({
  reasoning,
  isThinking,
}: {
  reasoning: string;
  isThinking?: boolean;
}) {
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
        <div className="scrollbar-slim max-h-96 overflow-y-auto border-t border-border bg-muted/20 px-3 py-3 text-sm italic text-muted-foreground">
          <MarkdownContent content={reasoning} streaming={false} />
        </div>
      )}
    </div>
  );
}
