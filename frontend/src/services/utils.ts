import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** '1.2s' / '84ms' latency formatting; null passes through. */
export function formatDuration(ms?: number | null): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Token counts grouped with thousands separators. */
export function formatTokens(n?: number | null): string | null {
  if (n === null || n === undefined) return null;
  return n.toLocaleString('en-US');
}

/** Cost stored as decimal USD string; shown in USD with appropriate precision. */
export function formatCost(costUsd?: string | null): string | null {
  if (!costUsd) return null;
  const cost = Number.parseFloat(costUsd);
  if (!Number.isFinite(cost)) return null;

  // Format based on magnitude
  if (cost === 0) return '$0.00';
  if (cost < 0.001) {
    // Very small costs: show in scientific notation or micro-dollars
    return `$${cost.toFixed(6)}`;
  }
  if (cost < 0.01) {
    // Small costs: 4 decimal places
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    // Medium costs: 3 decimal places
    return `$${cost.toFixed(3)}`;
  }
  // Large costs: standard 2 decimal places
  return `$${cost.toFixed(2)}`;
}

/** Chat live status labels (mirrors ai SDK ChatStatus). */
export function chatStatusText(status: 'submitted' | 'streaming' | 'ready' | 'error'): string {
  switch (status) {
    case 'submitted':
      return 'thinking';
    case 'streaming':
      return 'streaming';
    case 'error':
      return 'error';
    default:
      return '';
  }
}
