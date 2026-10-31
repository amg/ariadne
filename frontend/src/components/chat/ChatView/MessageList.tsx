import type { DisplayRow, HandoverProgress } from '@/components/chat/types';
import { MessageMetaRow } from '@/components/metadata';
import { chatStatusText } from '@/services/utils';
import { Fragment, type RefObject } from 'react';
import ThinkingIndicator from '../ThinkingIndicator';
import { DriftChoice } from './DriftChoice';
import { MessageRow } from './MessageRow';
import type { ChatViewStatus } from './types';

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

/**
 * The scrolling list of rows, with the drift choice under the paused
 * arrival and the thinking bubble at the end while a reply is awaited.
 * `viewportRef` is attached to the scrolling pane.
 */
export function MessageList({
  viewportRef,
  rows,
  status,
  busy,
  needsPendingBubble,
  pausedMessageId,
  handover,
  onRetryLast,
  onEditMessage,
  onContinueHere,
  onStartNewChat,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  rows: DisplayRow[];
  status: ChatViewStatus;
  busy: boolean;
  needsPendingBubble: boolean;
  pausedMessageId: string | null;
  handover: HandoverProgress;
  onRetryLast: () => void;
  onEditMessage: (messageId: string, content: string) => Promise<boolean>;
  onContinueHere: () => void;
  onStartNewChat: () => void;
}) {
  // The last user prompt is the only editable row — even when a (possibly
  // failed) assistant reply follows it.
  const lastUserId = [...rows].reverse().find((row) => row.message.role === 'user')?.id ?? null;

  return (
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
  );
}
