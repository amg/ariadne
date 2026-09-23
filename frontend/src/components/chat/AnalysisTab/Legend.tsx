import { DRIFT_COLORS } from './model';

export function Legend() {
  const entries: { color: string; label: string; dashed?: boolean }[] = [
    { color: DRIFT_COLORS.drift, label: 'Arrival drift (composite reading)' },
    { color: DRIFT_COLORS.trigger, label: 'Trigger (μ + k·max(σ, σ_floor), or T_segment)' },
    { color: DRIFT_COLORS.ledgerMean, label: 'Ledger mean (μ)', dashed: true },
    { color: DRIFT_COLORS.fire, label: 'Gate fire — segment ends' },
    { color: DRIFT_COLORS.pass, label: 'Accepted arrival' },
  ];
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5">
          {entry.dashed ? (
            <span
              className="inline-block w-4 border-t-2 border-dashed"
              style={{ borderColor: entry.color }}
            />
          ) : (
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
          )}
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
