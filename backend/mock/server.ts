import { startMockInferenceServer } from './inferenceServer';

/**
 * Standalone mock inference server for development:
 *   npm run mock          (backend workspace)
 * Point the backend at it with MOCK_AI_BASE_URL=http://127.0.0.1:4141/v1
 */
const port = Number(process.env.PORT ?? 4141);

const server = await startMockInferenceServer({ port });
console.log(`Mock inference server listening at ${server.baseUrl}`);
