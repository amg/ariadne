# Centralized Environment Configuration

All environment variables and their defaults are defined in a single location: `env.ts`.

## Philosophy

- **Single Source of Truth**: All environment variables and defaults live in one place
- **Not in compose files**: Defaults are in code, not scattered across configuration files
- **Stateless Singleton**: The `env` object reads directly from `process.env` but provides a unified interface
- **Type Safe**: Full TypeScript types for all configuration values

## Usage

```typescript
import { env, isInferenceConfigured, getCorsOrigins } from '@config/env';

// Access any environment variable - everything goes through env
const port = env.PORT;
const debug = env.DEBUG;
const model = env.DEFAULT_MODEL; // Default model ID accessed through env

// Use helper functions
if (isInferenceConfigured()) {
  // ...
}

const origins = getCorsOrigins();
```

## Available Configuration

### Server
- `NODE_ENV` - Environment name (default: 'development')
- `PORT` - Server port (default: 3001)
- `HOST` - Server host (default: '0.0.0.0')
- `DEBUG` - Enable debug logging (default: false)

### Database
- `DATABASE_URL` - Full connection string (VITEST_TEST_DATABASE_URL takes precedence in tests)
- `DB_HOST` - Database host (default: '127.0.0.1')
- `DB_PORT` - Database port (default: 5432)
- `DB_NAME` - Database name (default: 'chatbot')
- `DB_USER` - Database user (default: 'postgres')
- `DB_PASSWORD` - Database password (default: 'postgrespassword')

**Note**: An explicit `DATABASE_URL` wins; the `DB_*` parts only feed the fallback connection string assembled when no URL is set.

### AI Provider
- `DEEPINFRA_API_KEY` - DeepInfra API key (required for real provider)
- `DEFAULT_MODEL` - Default model ID (default: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
- `MOCK_AI_BASE_URL` - Mock server URL (overrides DeepInfra)
- `AI_STREAM_IDLE_TIMEOUT_MS` - Idle timeout in ms (default: 5000)
- `ENABLE_REASONING` - Enable reasoning output (default: true)

### Titling Service
- `AI_TITLING_TIMEOUT_MS` - Titling timeout in ms (default: 5000)
- `TITLING_MODEL` - Override model for titling (optional)

### Thread Analysis (live drift gate)
- `THREAD_ANALYSIS_MODE` - 'off' | 'heuristic' | 'always' (default: 'heuristic').
  `off` skips the live pipeline and hides the Analysis surface (stored signals
  survive and reappear when flipped back); `heuristic`/`always` run the live
  lane with that expansion tier.
- `JUDGE_MODEL` - Expansion-trigger judge model (default: 'Qwen/Qwen3.5-9B')
- `REWRITE_MODEL` - Expanded-signal rewrite model (default: 'Qwen/Qwen3.5-9B')

### CORS
- `CORS_ORIGINS` - Comma-separated allowed origins (optional, defaults to localhost)

### Logger
- `FORCE_COLOR` - Force color output
- `NO_COLOR` - Disable ANSI colors

## Testing

Tests can override environment variables before importing modules that read from `env`:

```typescript
// In test setup
process.env.MOCK_AI_BASE_URL = 'http://localhost:4141/v1';
process.env.AI_STREAM_IDLE_TIMEOUT_MS = '30';
```

The `env` object is evaluated at import time, so set env vars before importing the config module.
