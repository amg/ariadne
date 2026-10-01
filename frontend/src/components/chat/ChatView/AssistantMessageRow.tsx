import { MessageMetaRow } from '@/components/metadata';
import { chatStatusText } from '@/services/utils';
import { RefreshCw } from 'lucide-react';
import { BubbleContent } from './BubbleContent';
import type { ChatViewStatus, DisplayRow } from './types';

export function AssistantMessageRow({
  row,
  isLast,
  busy,
  status,
  onRetryLast,
}: {
  row: DisplayRow;
  isLast: boolean;
  busy: boolean;
  status: ChatViewStatus;
  onRetryLast: () => void;
}) {
  const { message, usage, streaming, reasoning } = row;
  // A stuck-empty row shows its retry inside the bubble (the "No reply
  // generated" card), so the meta retry only appears when the bubble carries
  // something itself — text, or reasoning a stop left behind.
  const isStuckEmpty = !streaming && message.content === '' && !(reasoning ?? '').trim();
  const showRetry = isLast && !busy && !isStuckEmpty;

  return (
    <div className="flex min-w-0 max-w-[85%] flex-col self-start md:max-w-[75%]">
      <div className="min-w-0 max-w-full self-start rounded-lg bg-muted p-3 text-foreground">
        <BubbleContent
          message={message}
          streaming={streaming}
          busy={busy}
          onRetryLast={onRetryLast}
          reasoning={reasoning}
        />
      </div>
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
    </div>
  );
}
