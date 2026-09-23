import type { ThreadSummary } from '@/services/api';
import { ModelPricing } from './ModelPricing';

type ModelInfo = ThreadSummary['models'][number];
type ModelRole = ModelInfo['roles'][number];

const ROLE_LABELS: Record<ModelRole, string> = {
  chat: 'Chat',
  embedding: 'Embedding',
  rewrite: 'Rewrite',
  judge: 'Judgement',
};

/** One model card: role labels, model id, pricing. */
export function ModelRow({ model }: { model: ModelInfo }) {
  const roles = model.roles.map((role) => ROLE_LABELS[role]).join(' · ');
  return (
    <div className="border-t py-2 first:border-t-0 first:pt-0 last:pb-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {roles}
      </p>
      <p className="truncate text-xs text-foreground" title={model.modelId}>
        {model.modelId}
      </p>
      {model.pricing ? (
        <ModelPricing pricing={model.pricing} />
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">No pricing data</p>
      )}
    </div>
  );
}
