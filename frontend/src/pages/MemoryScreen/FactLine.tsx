import type { UserFact } from '@/services/api';
import { cn } from '@/services/utils';
import { categoryDisplay } from './categoryDisplay';
import { formattedNotedDate, formattedStatedDate } from './factDates';

interface Props {
  fact: UserFact;
}

function factTooltip(fact: UserFact): string {
  const stated =
    fact.validAt === null ? 'No date stated' : `Dated ${formattedStatedDate(fact.validAt, 'day')}`;
  return `${fact.content}\n${stated} · Noted ${formattedNotedDate(fact.createdAt, 'day')}`;
}

function FactDates({ fact }: Props) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {fact.validAt !== null && (
        <>
          · <span className="text-foreground/80">
            {formattedStatedDate(fact.validAt, 'month')}
          </span>{' '}
        </>
      )}
      · noted {formattedNotedDate(fact.createdAt, 'month')}
    </span>
  );
}

function FactStatement({ fact }: Props) {
  if (fact.predicate === null || fact.object === null) {
    return <span className="min-w-0 truncate text-foreground">{fact.content}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground">{fact.predicate.replace(/_/g, ' ')}</span>
      <span className="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
        {fact.object}
      </span>
    </span>
  );
}

/** One-line summary of a Fact: category icon, statement, dates, suppression badge. */
export default function FactLine({ fact }: Props) {
  const { Icon, label } = categoryDisplay(fact.category);
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2 text-sm',
        fact.suppressed && 'opacity-60',
      )}
      title={factTooltip(fact)}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={label} role="img" />
      <FactStatement fact={fact} />
      <FactDates fact={fact} />
      {fact.suppressed && (
        <span className="shrink-0 rounded bg-yellow-900/30 px-1.5 py-0.5 text-xs text-yellow-600 dark:text-yellow-400">
          Suppressed
        </span>
      )}
    </div>
  );
}
