import { Button } from '@/components/ui/button';
import { MessageSquarePlus, MoveDown } from 'lucide-react';
import ThinkingIndicator from '../ThinkingIndicator';

/**
 * The choice a paused arrival waits for: reply here, or move the message
 * into a fresh chat. Sits under the paused user bubble. While the move is
 * in flight it shows that instead of the choice, so the wait is visible.
 */
export function DriftChoice({
  busy,
  handingOver,
  onContinueHere,
  onStartNewChat,
}: {
  busy: boolean;
  handingOver: boolean;
  onContinueHere: () => void;
  onStartNewChat: () => void;
}) {
  if (handingOver) {
    return (
      <p className="flex items-center gap-2 self-end rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        <ThinkingIndicator />
        Moving this message into a fresh chat&hellip;
      </p>
    );
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
