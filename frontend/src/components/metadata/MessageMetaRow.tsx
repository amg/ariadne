import type { MessageFinishReason, MessageUsage } from '@/services/api';
import { cn, formatCost, formatDuration, formatTokens } from '@/services/utils';

const FINISH_REASON_LABEL: Record<MessageFinishReason, string> = {
  stop: 'normal',
  length: 'length',
  content_filter: 'blocked',
  tool_calls: 'tools',
  timeout: 'timeout',
  interrupted: 'stopped',
};

/**
 * Extracts reasoning token display values from usage.
 */
function getReasoningDisplay(usage: MessageUsage | null): {
  value: string | number;
  label: string;
  title: string;
} {
  if (!usage) {
    return { value: '—', label: 'reasoning', title: 'Reasoning tokens (provider reported)' };
  }

  const { estimatedReasoningTokens, reasoningTokens } = usage;
  const hasEstimate = estimatedReasoningTokens != null;
  // DeepInfra reports 0 even when reasoning - only trust provider if > 0
  const hasMeaningfulProviderReport = reasoningTokens !== null && reasoningTokens > 0;

  if (hasEstimate && hasMeaningfulProviderReport) {
    return {
      value: estimatedReasoningTokens,
      label: 'reasoning',
      title: `Provider reported: ${reasoningTokens} | Our estimate: ${estimatedReasoningTokens}`,
    };
  }

  if (hasEstimate) {
    return {
      value: estimatedReasoningTokens,
      label: 'estimated reasoning',
      title: `Estimated from reasoning content: ${estimatedReasoningTokens} (DeepInfra reports 0)`,
    };
  }

  return {
    value: reasoningTokens ?? '—',
    label: 'reasoning',
    title: 'Reasoning tokens (provider reported)',
  };
}

/**
 * One metadata line under an assistant message: prompt / completion /
 * cached / reasoning / cost / time / status. While the reply streams,
 * `usage` is null and `status` shows the live state instead.
 */
export default function MessageMetaRow({
  usage,
  status,
  showLatency,
  action,
  className,
}: {
  usage: MessageUsage | null;
  status?: string;
  showLatency?: boolean;
  action?: React.ReactNode;
  className?: string;
}) {
  const prompt = usage ? usage.promptTokens - (usage.cachedInputTokens ?? 0) : null;
  const completion = usage ? usage.completionTokens - (usage.reasoningTokens ?? 0) : null;
  const reasoning = getReasoningDisplay(usage);

  return (
    <div
      className={cn(
        'flex max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-neutral-400',
        className,
      )}
    >
      {/* prompt */}
      <span title="Prompt tokens (excluding cached)">
        <span className="font-bold text-neutral-200">{formatTokens(prompt) ?? '—'}</span>
        <span className="text-neutral-500"> input</span>
      </span>
      {/* completion */}
      <span title="Completion tokens (excluding reasoning)">
        <span className="font-bold text-neutral-200">{formatTokens(completion) ?? '—'}</span>
        <span className="text-neutral-500"> output</span>
      </span>
      {/* cached */}
      <span title="Cached prompt tokens">
        <span className="font-bold text-neutral-200">
          {formatTokens(usage?.cachedInputTokens) ?? '—'}
        </span>
        <span className="text-neutral-500"> cached</span>
      </span>
      {/* reasoning */}
      <span title={reasoning.title}>
        <span className="font-bold text-neutral-200">{reasoning.value}</span>
        <span className="text-neutral-500"> {reasoning.label}</span>
      </span>
      {/* cost */}
      <span title="Cost in USD">
        <span className="font-bold text-neutral-200">{formatCost(usage?.costUsd) ?? '—'}</span>
      </span>
      {/* time — only on settled rows */}
      {showLatency ? (
        <span title="Latency">
          <span className="font-bold text-neutral-200">
            {formatDuration(usage?.latencyMs) ?? '—'}
          </span>
        </span>
      ) : null}
      {/* status */}
      <span
        title={usage ? 'finish reason' : 'stream state'}
        className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
      >
        {usage ? FINISH_REASON_LABEL[usage.finishReason] : (status ?? '—')}
      </span>
      {/* action (e.g. retry) */}
      {action}
    </div>
  );
}
