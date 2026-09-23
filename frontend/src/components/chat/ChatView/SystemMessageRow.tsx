import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { DisplayRow } from './types';

export function SystemMessageRow({ row }: { row: DisplayRow }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { message } = row;

  return (
    <div className="flex min-w-0 max-w-[85%] flex-col self-end md:max-w-[75%]">
      <div className="min-w-0 max-w-full self-end rounded-lg bg-slate-800/80 p-3 text-slate-300 border border-slate-700">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-sm font-medium hover:text-slate-100 transition-colors"
        >
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          System Prompt
        </button>
        {isExpanded && (
          <div className="mt-2 whitespace-pre-wrap break-words border-t border-slate-700 pt-2 text-sm text-slate-300/90">
            {message.content}
          </div>
        )}
      </div>
    </div>
  );
}
