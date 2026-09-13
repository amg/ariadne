import { Button } from '@/components/ui/button';
import type { Thread } from '@/services/api';
import { Info } from 'lucide-react';

type ThreadSidebarProps = {
  threads: Thread[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onAbout: () => void;
};

export default function ThreadSidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onNewChat,
  onAbout,
}: ThreadSidebarProps) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-muted/30 p-3">
      <Button onClick={onNewChat} className="w-full">
        New Chat
      </Button>
      <div className="mt-2 flex flex-1 flex-col gap-1 overflow-y-auto">
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelectThread(thread.id)}
            className={`w-full truncate rounded-md px-3 py-2 text-left text-sm ${
              thread.id === activeThreadId ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            }`}
          >
            {thread.title}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onAbout}
        className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <Info className="h-4 w-4" />
        About
      </button>
    </aside>
  );
}
