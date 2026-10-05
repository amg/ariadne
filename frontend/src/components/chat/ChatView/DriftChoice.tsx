import { Button } from '@/components/ui/button';
import { MessageSquarePlus, MoveDown } from 'lucide-react';

/**
 * The choice a paused arrival waits for: reply here, or move the message
 * into a fresh chat. Sits under the paused user bubble.
 */
export function DriftChoice({
  busy,
  onContinueHere,
  onStartNewChat,
}: {
  busy: boolean;
  onContinueHere: () => void;
  onStartNewChat: () => void;
}) {
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
