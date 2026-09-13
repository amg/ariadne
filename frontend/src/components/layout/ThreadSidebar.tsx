import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Thread } from '@/services/api';
import { Info, Pencil } from 'lucide-react';
import { useState } from 'react';

type Props = {
  threads: Thread[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onAbout: () => void;
  /** Persists a rename; blank drafts are filtered before calling this. */
  onRename: (id: string, title: string) => void;
  /** In-flight rename shown optimistically while the rename fetcher settles. */
  pendingRename: { threadId: string; title: string } | null;
};

export default function ThreadSidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onNewChat,
  onAbout,
  onRename,
  pendingRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const displayTitle = (thread: Thread) =>
    pendingRename?.threadId === thread.id ? pendingRename.title : thread.title;

  const startEditing = (thread: Thread) => {
    setEditingId(thread.id);
    setDraft(displayTitle(thread));
  };

  const commitEdit = (thread: Thread) => {
    const trimmed = draft.trim();
    setEditingId(null);
    if (trimmed && trimmed !== displayTitle(thread)) {
      onRename(thread.id, trimmed);
    }
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-muted/30 p-3">
      <Button onClick={onNewChat} className="w-full">
        New Chat
      </Button>
      <div className="mt-2 flex flex-1 flex-col gap-1 overflow-y-auto">
        {threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          const isEditing = thread.id === editingId;
          const title = displayTitle(thread);

          return (
            <div
              key={thread.id}
              className={`group flex items-center gap-1 rounded-md pr-1 ${
                isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              }`}
            >
              {isEditing ? (
                <Input
                  autoFocus
                  value={draft}
                  aria-label="Thread name"
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(thread);
                    else if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={() => commitEdit(thread)}
                  className="h-8 px-2 text-sm"
                />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onSelectThread(thread.id)}
                    onDoubleClick={() => startEditing(thread)}
                    className="min-w-0 flex-1 truncate rounded-md py-2 pl-3 text-left text-sm"
                  >
                    {title}
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${title}`}
                    onClick={() => startEditing(thread)}
                    className={`shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground group-focus-within:opacity-100 ${
                      isActive
                        ? 'hover:text-primary-foreground'
                        : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          );
        })}
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
