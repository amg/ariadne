import { useEffect, useState } from 'react';

const ONE_LINERS = [
  'Reading the room…',
  'Consulting the gravity point…',
  'Counting baggage…',
  'Weighing the anchor…',
  'Checking drift…',
] as const;

/** Rotating loading copy while signals are missing or in flight. */
export function AnalysisSpinner() {
  const [lineIndex, setLineIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setLineIndex((index) => (index + 1) % ONE_LINERS.length);
    }, 2400);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
      <p className="text-sm italic">{ONE_LINERS[lineIndex] ?? ''}</p>
    </div>
  );
}
