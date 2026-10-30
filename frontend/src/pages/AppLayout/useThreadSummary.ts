import { type ThreadSummary, fetchThreadSummary, refreshModelPricing } from '@/services/api';
import { useEffect, useState } from 'react';

/**
 * The summary (cost, tokens and so on) of the Thread being viewed, or null
 * when none is. `refresh` reads it again; `refreshPricing` re-reads the
 * model prices and then the summary, so the context limit is current.
 */
export function useThreadSummary(threadId: string | null) {
  const [summary, setSummary] = useState<ThreadSummary | null>(null);

  // Fetch the summary once per active thread. NOT keyed on the sidebar's
  // threads: that identity churns with every loader revalidation and fetcher
  // submit, and used to re-fetch (and 3x) the summary on a page reload.
  useEffect(() => {
    if (!threadId) {
      setSummary(null);
      return;
    }
    let stale = false;
    fetchThreadSummary(threadId)
      .then((fetched) => {
        if (!stale) setSummary(fetched);
      })
      .catch((err) => {
        if (stale) return;
        console.error('Failed to fetch thread summary:', err);
        setSummary(null);
      });
    return () => {
      stale = true;
    };
  }, [threadId]);

  // Called after each message.
  const refresh = async () => {
    if (!threadId) return;
    try {
      setSummary(await fetchThreadSummary(threadId));
    } catch (err) {
      console.error('Failed to refresh thread summary:', err);
    }
  };

  const refreshPricing = async () => {
    const result = await refreshModelPricing();
    if (result.rateLimited) return result;
    if (result.success) await refresh();
    else console.error('Failed to refresh model pricing:', result.error);
    return result;
  };

  return { summary, refresh, refreshPricing };
}
