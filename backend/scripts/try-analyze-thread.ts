#!/usr/bin/env tsx
import '@config/dotenv';
import { analyzeThread } from '@services/threadAnalysis';
import { isValidUuid } from '@services/validation';

/**
 * Manual smoke runner for the early analyzer seam — prints the
 * report shell as JSON to stdout. Replaced by the full `analyze:thread`
 * CLI (flags, progress, HTML/JSON artifacts) in the task.
 *
 *   npm run try:analyze -- <threadId>              (backend workspace)
 *   docker compose exec backend npx tsx scripts/try-analyze-thread.ts <threadId>
 *
 * Needs the standard backend DB env resolution (`DATABASE_URL`/`DB_*`)
 * and a configured provider (`MOCK_AI_BASE_URL` or `DEEPINFRA_API_KEY`).
 * Writes `analysis.message_embeddings` rows on first use; chat data is never
 * mutated.
 */

const threadId = process.argv[2];
if (!threadId || !isValidUuid(threadId)) {
  console.error('Usage: try-analyze-thread <threadId>');
  process.exit(1);
}

const result = await analyzeThread(threadId);

if (result.type === 'error') {
  console.error(`analysis failed: ${result.code}${result.message ? ` — ${result.message}` : ''}`);
  process.exit(1);
}

console.log(JSON.stringify(result.data, null, 2));
