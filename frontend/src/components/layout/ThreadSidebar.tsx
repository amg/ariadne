import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { Thread } from '@/services/api';
import { DEFAULT_THREAD_TITLE, TITLE_GENERATING_SENTINEL } from '@/services/api';
import {
  Ellipsis,
  Info,
  LogOut,
  MemoryStick,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { signOut } from 'supertokens-auth-react/recipe/session';

type Props = {
  threads: Thread[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onAbout: () => void;
  onMemory: () => void;
  onSettings: () => void;
  /** Persists a rename; blank drafts are filtered before calling this. */
  onRename: (id: string, title: string) => void;
  /** Permanently deletes a thread (messages go with it). */
  onDelete: (id: string) => void;
  /** Retriggers auto-titling for the thread. */
  onRegenerateTitle: (id: string) => void;
  /** In-flight rename shown optimistically while the rename fetcher settles. */
  pendingRename: { threadId: string; title: string } | null;
};

export default function ThreadSidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onNewChat,
  onAbout,
  onMemory,
  onSettings,
  onRename,
  onDelete,
  onRegenerateTitle,
  pendingRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const displayTitle = (thread: Thread) => {
    if (pendingRename?.threadId === thread.id) return pendingRename.title;
    return thread.title ?? DEFAULT_THREAD_TITLE;
  };

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
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-muted/30 p-3 pt-12 nav:pt-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium text-muted-foreground">Chats</span>
        <Button
          variant="outline"
          size="icon"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="h-8 w-8 rounded-md text-muted-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="scrollbar-slim mt-2 flex flex-1 flex-col gap-1 overflow-y-auto">
        {threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          const isEditing = thread.id === editingId;
          const title = displayTitle(thread);

          return (
            <div
              key={thread.id}
              className={`group flex items-center gap-1 rounded-md pr-1 ${
                isActive ? 'bg-muted' : 'hover:bg-muted/60'
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
                    className="min-w-0 flex items-center flex-1 truncate rounded-md p-2 pl-3 text-left text-sm"
                  >
                    {title === TITLE_GENERATING_SENTINEL ? (
                      <span className="inline-block h-4 w-24 animate-pulse rounded bg-foreground/10" />
                    ) : (
                      title
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${title}`}
                    onClick={() => startEditing(thread)}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted/80 hover:text-foreground focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`More options for ${title}`}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted/80 hover:text-foreground focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                      >
                        <Ellipsis className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-40">
                      <DropdownMenuItem onSelect={() => onRegenerateTitle(thread.id)}>
                        <RefreshCw className="h-4 w-4" />
                        Regenerate Title
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(thread.id)}>
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-auto flex flex-col gap-1 border-t p-2">
        <button
          type="button"
          onClick={onMemory}
          className="flex items-center gap-2 rounded px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <MemoryStick className="h-4 w-4" />
          Memory
        </button>
        <button
          type="button"
          onClick={onSettings}
          className="flex items-center gap-2 rounded px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
        <button
          type="button"
          onClick={onAbout}
          className="flex items-center gap-2 rounded px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <Info className="h-4 w-4" />
          About
        </button>
        <button
          type="button"
          onClick={async () => {
            await signOut();
            window.location.href = '/auth';
          }}
          className="flex items-center gap-2 rounded px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </div>
    </aside>
  );
}
