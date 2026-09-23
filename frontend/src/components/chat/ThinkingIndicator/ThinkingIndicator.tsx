import { cn } from '@/services/utils';

/** Bouncing three-dot "assistant is thinking" indicator. */
const DOT_DELAYS_MS = [0, 160, 320];

export default function ThinkingIndicator({ className }: { className?: string }) {
  return (
    <span
      // biome-ignore lint/a11y/useSemanticElements: <output> is a form element;
      // a status span is the right fit for a decorative indicator.
      role="status"
      aria-label="Assistant is thinking"
      className={cn('flex items-center gap-1 py-0.5', className)}
    >
      {DOT_DELAYS_MS.map((delay) => (
        <span
          key={delay}
          className="thinking-dot h-2 w-2 rounded-full bg-neutral-400"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
