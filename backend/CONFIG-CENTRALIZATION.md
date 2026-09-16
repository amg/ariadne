# Environment Configuration Centralization

## Summary

All environment variables and their defaults are now centralized in a single location: `src/config/env.ts`.

## What Changed

### Before
- Environment variables were scattered across:
  - `docker-compose.yml` (defaults in volume mounts)
  - `.env.example` files
  - Direct `process.env` reads in multiple files (`config.ts`, `db.ts`, `logger.ts`, etc.)
  - Each file had its own defaults duplicated

### After
- **Single Source of Truth**: All env vars and defaults in `src/config/env.ts`
- **Stateless Singleton**: The `env` object reads directly from `process.env` at access time
- **Lazy Evaluation**: Uses getters so tests can override `process.env` before values are read
- **Type Safe**: Full TypeScript types for all configuration values
- **No Defaults in docker-compose**: All defaults live in code only

## Files Modified

1. **Created**: `src/config/env.ts` - Central configuration module
2. **Created**: `src/config/README.md` - Usage documentation
3. **Updated**: `src/services/aiService/config.ts` - Now imports from central config
4. **Updated**: `src/db/db.ts` - Now imports from central config
5. **Updated**: `src/logger.ts` - Now imports from central config
6. **Updated**: `src/services/titlingService.ts` - Now imports from central config
7. **Updated**: `src/services/modelConfigService.ts` - Imports DEFAULT_MODEL_ID from central config
8. **Updated**: `src/services/aiService/index.ts` - Re-exports from central config
9. **Updated**: `tsconfig.json` - Added `@config/*` path alias
10. **Updated**: `vitest.config.ts` - Added `@config` alias for tests

## Usage

```typescript
import { env, isInferenceConfigured, getCorsOrigins } from '@config/env';

// Access any environment variable - everything goes through env
const port = env.PORT;           // Reads from process.env.PORT or default 3001
const debug = env.DEBUG;         // Reads from process.env.DEBUG or default false
const model = env.DEFAULT_MODEL; // Default model ID accessed through env

// Use helper functions
if (isInferenceConfigured()) {
  // AI provider is configured
}

const origins = getCorsOrigins(); // Parse CORS_ORIGINS into array
```

## Available Configuration

All defaults are defined in `src/config/env.ts`:

### Server
- `NODE_ENV` - Environment name (default: 'development')
- `PORT` - Server port (default: 3001)
- `HOST` - Server host (default: '0.0.0.0')
- `DEBUG` - Enable debug logging (default: false)

### Database
- `DATABASE_URL` - Full connection string
- `DB_HOST` - Database host (default: '127.0.0.1')
- `DB_PORT` - Database port (default: 5432)
- `DB_NAME` - Database name (default: 'chatbot')
- `DB_USER` - Database user (default: 'postgres')
- `DB_PASSWORD` - Database password (default: 'postgrespassword')

### AI Provider
- `DEEPINFRA_API_KEY` - DeepInfra API key
- `DEFAULT_MODEL` - Default model ID (default: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
- `MOCK_AI_BASE_URL` - Mock server URL
- `AI_STREAM_IDLE_TIMEOUT_MS` - Idle timeout in ms (default: 5000)
- `ENABLE_REASONING` - Enable reasoning output (default: true)

### Titling Service
- `AI_TITLING_TIMEOUT_MS` - Titling timeout in ms
- `TITLING_MODEL` - Override model for titling

### CORS
- `CORS_ORIGINS` - Comma-separated allowed origins

### Logger
- `FORCE_COLOR` - Force color output
- `NO_COLOR` - Disable ANSI colors

## Testing

Tests can override environment variables before importing modules:

```typescript
// In test file
const savedValue = process.env.MOCK_AI_BASE_URL;

beforeAll(() => {
  process.env.MOCK_AI_BASE_URL = 'http://localhost:4141/v1';
});

afterAll(() => {
  process.env.MOCK_AI_BASE_URL = savedValue ?? '';
});
```

The lazy evaluation ensures the new values are read when accessed.

## Validation

A custom validation script ensures `process.env` is only used in the central config:

```bash
npm run validate:env
```

This script:
- Scans all TypeScript files in `src/`
- Detects any `process.env` usage outside `src/config/env.ts`
- Provides clear error messages with line numbers
- Can be extended with additional validation rules

See `scripts/README.md` for adding new validation rules.

## Next Steps

To apply the same pattern to other projects (alex-agent, alex-libre-chat, etc.):

1. Create `src/config/env.ts` in each project
2. Identify all `process.env` usage in the codebase
3. Move defaults to the central config
4. Update imports to use the central config
5. Remove defaults from docker-compose.yml (keep only required overrides)
6. Add validation script to enforce the pattern
