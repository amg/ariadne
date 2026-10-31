import type { ThreadSummary } from '@/services/api';

type ModelInfo = ThreadSummary['models'][number];

/**
 * Formats model pricing for display
 */
export function ModelPricing({ pricing }: { pricing: NonNullable<ModelInfo['pricing']> }) {
  const formatPrice = (price: number | null | undefined) => {
    if (price == null) return '—';
    return price < 0.01 ? `$${price.toFixed(4)}` : `$${price.toFixed(2)}`;
  };

  const savingsPct =
    pricing.cachedRateMultiplier != null
      ? Math.round((1 - pricing.cachedRateMultiplier) * 100)
      : null;

  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span title="Input price per million tokens">
          <span className="font-medium text-foreground">Input:</span>{' '}
          {formatPrice(pricing.inputPricePerMillion)}/1M
        </span>
        <span title="Output price per million tokens">
          <span className="font-medium text-foreground">Output:</span>{' '}
          {formatPrice(pricing.outputPricePerMillion)}/1M
        </span>
      </div>
      {pricing.cachedPricePerMillion !== null && (
        <div
          title={`Price per million cached input tokens${savingsPct != null ? ` — saves ${savingsPct}% vs input price` : ''}`}
        >
          <span className="font-medium text-foreground">Cache input:</span>{' '}
          {formatPrice(pricing.cachedPricePerMillion)}/1M
          {savingsPct != null && <span className="text-green-600"> · saves {savingsPct}%</span>}
        </div>
      )}
    </div>
  );
}
