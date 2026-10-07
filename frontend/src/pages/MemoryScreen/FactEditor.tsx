import type { UserFact } from '@/services/api';
import { useState } from 'react';
import { editFactContent } from './factActions';
import { formattedStatedDate } from './factDates';

interface Props {
  fact: UserFact;
  onClose: (saved: boolean) => void;
}

function dateHint(validAt: string | null): string {
  if (validAt === null) {
    return 'To date this fact, say when it became true, e.g. "since March 2024".';
  }
  return `Dated ${formattedStatedDate(validAt, 'day')}. The date is read from the sentence, so keep it in the text (e.g. "since 2019") or it will be dropped.`;
}

/** Inline editor for a Fact's sentence; saving re-evaluates how the Fact is filed. */
export default function FactEditor({ fact, onClose }: Props) {
  const [content, setContent] = useState(fact.content);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    const saved = await editFactContent(fact, content);
    setIsSaving(false);
    if (saved) onClose(true);
  };

  return (
    <div className="space-y-2 py-2 pl-9 pr-3">
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        className="w-full rounded border border-input bg-background p-2 text-sm text-foreground focus:border-ring focus:outline-none"
        rows={3}
      />
      <p className="text-xs text-muted-foreground">{dateHint(fact.validAt)}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isSaving ? 'Re-evaluating...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => onClose(false)}
          disabled={isSaving}
          className="rounded bg-secondary px-3 py-1 text-sm text-secondary-foreground hover:bg-secondary/80"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
