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

/** Cost stored as decimal USD string; shown in micro-USD for homelab scale. */
export function formatCost(costUsd?: string | null): string | null {
  if (!costUsd) return null;
  const micro = Number.parseFloat(costUsd) * 1_000_000;
  if (!Number.isFinite(micro)) return null;
  return `${micro.toFixed(2)}µ`;
}

/** Chat live status labels (mirrors ai SDK ChatStatus). */
export function chatStatusText(status: 'submitted' | 'streaming' | 'ready' | 'error'): string {
  switch (status) {
    case 'submitted':
      return 'connecting';
    case 'streaming':
      return 'streaming';
    case 'error':
      return 'error';
    default:
      return '';
  }
}
