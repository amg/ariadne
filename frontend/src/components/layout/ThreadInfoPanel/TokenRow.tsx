export function TokenRow({
  label,
  value,
  bold,
  title,
}: {
  label: string;
  value: string | null;
  bold?: boolean;
  title?: string;
}) {
  return (
    <div className="flex justify-between" title={title}>
      <span className="text-muted-foreground">{label}:</span>
      <span className={bold ? 'font-bold text-foreground' : 'font-medium text-foreground'}>
        {value ?? '—'}
      </span>
    </div>
  );
}
