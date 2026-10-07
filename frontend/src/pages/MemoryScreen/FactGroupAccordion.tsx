import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import FactLine from './FactLine';
import FactRow from './FactRow';
import GroupActionsMenu from './GroupActionsMenu';
import { deleteFacts, setFactsSuppressed } from './factActions';
import type { FactGroup } from './groupFacts';

const PREVIEW_FACT_COUNT = 3;

interface Props {
  group: FactGroup;
  onChanged: () => void;
}

/**
 * A collapsible group of Facts about one subject. Collapsed, it previews
 * the newest Facts; expanded, every Fact gets its own actions.
 */
export default function FactGroupAccordion({ group, onChanged }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const factCount = group.facts.length;
  const hiddenCount = factCount - PREVIEW_FACT_COUNT;
  const allSuppressed = group.facts.every((fact) => fact.suppressed);
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  const runBulkAction = async (action: () => Promise<void>) => {
    setIsBusy(true);
    await action();
    setIsBusy(false);
    onChanged();
  };

  const handleSuppressToggle = () =>
    runBulkAction(() => setFactsSuppressed(group.facts, !allSuppressed));

  const handleDeleteAll = () => {
    const question = `Delete all ${factCount} facts in "${group.heading}"? This cannot be undone.`;
    if (!window.confirm(question)) return;
    runBulkAction(() => deleteFacts(group.facts));
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{group.heading}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            ({factCount} {factCount === 1 ? 'fact' : 'facts'})
          </span>
        </button>
        <GroupActionsMenu
          heading={group.heading}
          allSuppressed={allSuppressed}
          disabled={isBusy}
          onSuppressToggle={handleSuppressToggle}
          onDeleteAll={handleDeleteAll}
        />
      </div>

      {isExpanded ? (
        <>
          <ul className="divide-y divide-border border-t border-border">
            {group.facts.map((fact) => (
              <li key={fact.id}>
                <FactRow fact={fact} onChanged={onChanged} />
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 border-t border-border px-3 py-2 pl-9 text-xs">
            <span className="text-muted-foreground">Whole group:</span>
            <button
              type="button"
              onClick={handleSuppressToggle}
              disabled={isBusy}
              className="text-foreground hover:underline disabled:opacity-50"
            >
              {allSuppressed ? 'Unsuppress all' : 'Suppress all'}
            </button>
            <span className="text-muted-foreground">|</span>
            <button
              type="button"
              onClick={handleDeleteAll}
              disabled={isBusy}
              className="text-destructive hover:underline disabled:opacity-50"
            >
              Delete all
            </button>
          </div>
        </>
      ) : (
        <ul className="space-y-1 pb-3 pl-9 pr-3">
          {group.facts.slice(0, PREVIEW_FACT_COUNT).map((fact) => (
            <li key={fact.id}>
              <FactLine fact={fact} />
            </li>
          ))}
          {hiddenCount > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setIsExpanded(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                +{hiddenCount} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
