import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EllipsisVertical, Eye, EyeOff, Trash2 } from 'lucide-react';

interface Props {
  heading: string;
  allSuppressed: boolean;
  disabled: boolean;
  onSuppressToggle: () => void;
  onDeleteAll: () => void;
}

/** Bulk actions for every Fact in a group. */
export default function GroupActionsMenu({
  heading,
  allSuppressed,
  disabled,
  onSuppressToggle,
  onDeleteAll,
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Actions for all facts in ${heading}`}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/80 hover:text-foreground disabled:opacity-50"
        >
          <EllipsisVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onSuppressToggle}>
          {allSuppressed ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          {allSuppressed ? 'Unsuppress all' : 'Suppress all'}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDeleteAll}>
          <Trash2 className="h-4 w-4" />
          Delete all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
