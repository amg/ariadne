import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { EditBox } from './EditBox';
import type { DisplayRow } from './types';

export function UserMessageRow({
  row,
  isLastUser,
  busy,
  onEditMessage,
}: {
  row: DisplayRow;
  isLastUser: boolean;
  busy: boolean;
  onEditMessage: (messageId: string, content: string) => void;
}) {
  const { message } = row;
  const [draft, setDraft] = useState<string | null>(null);
  const isEditing = draft !== null;
  const showEdit = isLastUser && !busy && !isEditing;
  const fired = row.verdict?.verdict === 'fire';
  const firedSlow = row.verdict?.fireChannel === 'slow';

  let bgClass = 'bg-primary text-primary-foreground';
  if (firedSlow) {
    bgClass = 'bg-green-700 text-green-50';
  } else if (fired) {
    bgClass = 'bg-purple-600 text-purple-50';
  }

  return (
    <div className="flex min-w-0 max-w-[85%] flex-col self-end md:max-w-[75%]">
      {isEditing ? (
        <EditBox
          draft={draft ?? ''}
          onDraftChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={(content) => {
            onEditMessage(message.id, content);
            setDraft(null);
          }}
        />
      ) : (
        <div
          className={`max-w-full self-end whitespace-pre-wrap break-words rounded-lg p-3 ${bgClass}`}
          title={
            firedSlow
              ? 'Slow topic drift: Page-Hinkley detected a gradual departure from the topic'
              : fired
                ? 'Topic drift: the thread-health gate judged this prompt a departure'
                : undefined
          }
        >
          {message.content}
        </div>
      )}
      {showEdit ? (
        <div className="mt-1 flex items-center gap-2 self-end">
          <button
            type="button"
            onClick={() => setDraft(message.content)}
            title="Edit message"
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
            edit
          </button>
        </div>
      ) : null}
    </div>
  );
}
