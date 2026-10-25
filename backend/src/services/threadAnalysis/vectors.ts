/**
 * Cosine distance (1 − cosine similarity) between two vectors, computed
 * in process. Clamped to [0, 2]: float round-tripping through storage can
 * push the similarity fractionally past 1 for identical vectors.
 */
export function cosineDistance(a: readonly number[], b: readonly number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1; // degenerate zero vector: maximally distant
  return Math.min(2, Math.max(0, 1 - dot / denom));
}
