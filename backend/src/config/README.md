# Centralized Environment Configuration

All environment variables and their defaults are defined in a single location: `env.ts`.

## Philosophy

- **Single Source of Truth**: All environment variables and defaults live in one place
- **Not in compose files**: Defaults are in code, not scattered across configuration files
- **Stateless Singleton**: The `env` object reads directly from `process.env` but provides a unified interface
- **Type Safe**: Full TypeScript types for all configuration values

## Usage

```typescript
import { env } from '@config/env';

// Access any environment variable - everything goes through env
const port = env.PORT;
const debug = env.DEBUG;
const model = env.DEFAULT_MODEL; // Default model ID accessed through env
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

### Spend budget
- `DAILY_SPEND_BUDGET_USD` - Daily spend budget in USD across every metered
  call; unset or empty means no budget. A value that is not a number of at
  least 0 is refused rather than read as "no budget".

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
- `MEMORY_MODEL` - Fact extraction and duplicate-check model (default: 'Qwen/Qwen3.5-9B')

### Waits on queued work
- `GATE_WAIT_MS` - How long a chat request holds for the drift gate's verdict
  before answering "still checking" (default: 10000)
- `HANDOVER_WAIT_MS` - How long a handover request holds for the closed
  segment's capture before answering "still saving" (default: 10000)

### Background worker
- `WORKER_JOB_CONCURRENCY` - Queue jobs one process runs side by side; a
  whole number of at least 1, otherwise the process refuses to start
  (default: 4)

### Monitoring
- `STATE_LOG_INTERVAL_SECONDS` - Seconds between the state records a process
  logs of what it carries (push streams open, how long the oldest job has
  waited); a whole number of at least 1, otherwise the process refuses to
  start (default: 20)
- `ECS_CONTAINER_METADATA_URI_V4` - Set by ECS, never by hand. Each app
  record names the ECS task it came from; without it, a record names the
  host and process instead

### Feature toggles
- `FEATURE_MEMORY` - User memory: Fact capture, Thread Seeds, the Memory
  screen and settings (default: false). Toggles say whether a feature exists
  in the deployment; `features.ts` is their registry, read once at boot, so
  changing one takes a backend restart.

### CORS
- `CORS_ORIGINS` - Comma-separated allowed origins (optional; unset names none — the home
  server falls back to its localhost defaults, and AWS refuses to start)

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
