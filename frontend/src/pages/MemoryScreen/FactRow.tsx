import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { UserFact } from '@/services/api';
import { EllipsisVertical, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import FactEditor from './FactEditor';
import FactLine from './FactLine';
import { deleteFact, toggleFactSuppressed } from './factActions';

interface Props {
  fact: UserFact;
  onChanged: () => void;
}

/** A Fact with its own edit, suppress, and delete actions. */
export default function FactRow({ fact, onChanged }: Props) {
  const [isEditing, setIsEditing] = useState(false);

  const handleEditorClose = (saved: boolean) => {
    setIsEditing(false);
    if (saved) onChanged();
  };

  const handleSuppressToggle = async () => {
    if (await toggleFactSuppressed(fact)) onChanged();
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this fact? This cannot be undone.')) return;
    if (await deleteFact(fact)) onChanged();
  };

  if (isEditing) {
    return <FactEditor fact={fact} onClose={handleEditorClose} />;
  }

  return (
    <div className="flex items-center gap-2 py-1.5 pl-9 pr-2">
      <FactLine fact={fact} />
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" />
        Edit
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More actions for this fact"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
          >
            <EllipsisVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onSelect={handleSuppressToggle}>
            {fact.suppressed ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            {fact.suppressed ? 'Unsuppress' : 'Suppress'}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={handleDelete}>
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
