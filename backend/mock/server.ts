import { startMockInferenceServer } from './inferenceServer';

/**
 * Standalone mock inference server for development:
 *   npm run mock          (backend workspace)
 * Point the backend at it with MOCK_AI_BASE_URL=http://127.0.0.1:4141/v1
 * Set HOST=0.0.0.0 when the backend runs on another machine.
 */
const port = Number(process.env.PORT ?? 4141);
const host = process.env.HOST ?? '127.0.0.1';

const server = await startMockInferenceServer({ port, host });
console.log(`Mock inference server listening on ${host}:${port}`);
