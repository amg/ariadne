import { Button } from '@/components/ui/button';
import { useEffect, useRef } from 'react';

/** Inline editor for the last user message. Saving an empty draft is impossible. */
export function EditBox({
  draft,
  onDraftChange,
  onCancel,
  onSave,
}: {
  draft: string;
  onDraftChange: (next: string) => void;
  onCancel: () => void;
  /** Receives the trimmed draft; guaranteed non-empty by the Save guard. */
  onSave: (content: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Focus on open; an effect (not the autoFocus attribute) keeps it screen-reader friendly.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const save = () => {
    const content = draft.trim();
    if (!content) return;
    onSave(content);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        rows={4}
        className="w-full resize-y rounded-lg border bg-background p-3 text-sm text-foreground focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!draft.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
