import { Button } from '@/components/ui/button';
import { MessageSquarePlus, MoveDown } from 'lucide-react';
import ThinkingIndicator from '../ThinkingIndicator';
import type { HandoverProgress } from './types';

function HandoverNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 self-end rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
      <ThinkingIndicator />
      {children}
    </p>
  );
}

/**
 * The choice a paused arrival waits for: reply here, or move the message
 * into a fresh chat. Sits under the paused user bubble. While the move is
 * under way it says what it is waiting on instead of the choice.
 */
export function DriftChoice({
  busy,
  handover,
  onContinueHere,
  onStartNewChat,
}: {
  busy: boolean;
  handover: HandoverProgress;
  onContinueHere: () => void;
  onStartNewChat: () => void;
}) {
  switch (handover) {
    case 'saving-memory':
      return (
        <HandoverNotice>
          Remembering this chat, then moving your message to a fresh one&hellip;
        </HandoverNotice>
      );
    case 'moving':
      return <HandoverNotice>Moving this message into a fresh chat&hellip;</HandoverNotice>;
    case 'idle':
      break;
  }
  return (
    <div className="flex flex-col items-end gap-2 self-end">
      <p className="text-xs text-muted-foreground">
        This message changes the topic. Where should it continue?
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={busy}
          onClick={onStartNewChat}
        >
          <MessageSquarePlus />
          Start new chat from this message
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={busy}
          onClick={onContinueHere}
        >
          <MoveDown />
          Continue in this thread
        </Button>
      </div>
    </div>
  );
}
