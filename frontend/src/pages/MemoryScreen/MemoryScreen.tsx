import { type UserFact, fetchUserFacts } from '@/services/api';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import FactGroupAccordion from './FactGroupAccordion';
import { factGroupsBySubject } from './groupFacts';

export default function MemoryScreen() {
  const [facts, setFacts] = useState<UserFact[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadFacts = useCallback(async () => {
    setIsRefreshing(true);
    try {
      setFacts(await fetchUserFacts());
    } catch (error) {
      toast.error('Failed to load facts', {
        description: error instanceof Error ? error.message : String(error),
      });
      setFacts((current) => current ?? []);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadFacts();
  }, [loadFacts]);

  const groups = useMemo(() => factGroupsBySubject(facts ?? []), [facts]);

  if (facts === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading facts...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 justify-center overflow-y-auto p-6">
      <div className="w-full max-w-4xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Memory</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              View and manage what the assistant remembers about you
            </p>
          </div>
          <button
            type="button"
            onClick={loadFacts}
            disabled={isRefreshing}
            className="rounded bg-secondary px-4 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
            <p className="text-muted-foreground">
              No facts yet. Facts will appear here as you chat with the assistant.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <FactGroupAccordion key={group.key} group={group} onChanged={loadFacts} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
