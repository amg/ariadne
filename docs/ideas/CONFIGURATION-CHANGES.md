# Configuration Externalization Summary

## Overview
All hardcoded configuration values have been externalized to environment variables for AWS and cloud compatibility.

## Changes Made

### 1. Backend Server Configuration
**File**: `backend/app/server.ts`

**Before**:
```typescript
await app.listen({ port: 3001, host: '0.0.0.0' });
console.log('Server is running on http://127.0.0.1:3001');
```

**After**:
```typescript
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

await app.listen({ port: PORT, host: HOST });
console.log(`Server is running on http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
```

### 2. Environment Variable Files

#### Root Level (`.env.example`)
Created comprehensive environment template with:
- Server configuration (PORT, HOST, FRONTEND_PORT)
- Database configuration (connection string or individual components)
- AI provider configuration (API keys, model, timeout)
- AWS deployment notes

#### Backend (`backend/.env.example`)
Updated with:
- PORT and HOST variables
- All existing database and AI configuration
- Comments explaining each variable

#### Frontend (`frontend/.env.example`)
Created with:
- VITE_API_PROXY_TARGET for development
- AWS deployment notes

### 3. Docker Compose Configuration
**File**: `docker-compose.yml`

**Changes**:
- Added backend service with environment variables
- Added frontend service with environment variables
- All ports and credentials now use environment variables with defaults
- Added Docker network for service communication
- Database credentials use environment variables

**Example**:
```yaml
backend:
  environment:
    - PORT=${PORT:-3001}
    - HOST=${HOST:-0.0.0.0}
    - DATABASE_URL=postgres://${DB_USER:-postgres}:${DB_PASSWORD:-postgrespassword}@db:5432/${DB_NAME:-chatbot}
```

### 4. Dockerfiles
Created:
- `Dockerfile.backend` - Backend container with configurable port
- `Dockerfile.frontend` - Frontend build and nginx serving

### 5. Frontend Vite Configuration
**File**: `frontend/vite.config.ts`

**Before**:
```typescript
target: 'http://127.0.0.1:3001',
```

**After**:
```typescript
target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
```

### 6. Documentation

#### AWS-DEPLOYMENT.md
Comprehensive guide covering:
- SSE timeout limitations on AWS services
- Recommended architecture (NLB + ECS + RDS)
- Environment variable configuration
- ECS task definition example
- CloudFront configuration
- Monitoring and alerting
- Security checklist
- Troubleshooting guide

#### README.md
Updated with:
- Environment variable documentation
- Cloud-ready feature mention
- AWS deployment section
- Quick start instructions

## Environment Variables Reference

### Server Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Backend server port |
| HOST | 0.0.0.0 | Backend server host |
| FRONTEND_PORT | 5173 | Frontend dev server port |

### Database Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| DATABASE_URL | - | Full PostgreSQL connection string |
| DB_HOST | localhost | Database host |
| DB_PORT | 5432 | Database port |
| DB_NAME | chatbot | Database name |
| DB_USER | postgres | Database user |
| DB_PASSWORD | postgrespassword | Database password |

### AI Provider Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| DEEPINFRA_API_KEY | - | DeepInfra API key (required for production) |
| DEFAULT_MODEL | Qwen/Qwen3.5-9B | Default AI model |
| AI_BASE_URL | - | Mock inference server URL (development) |
| AI_STREAM_IDLE_TIMEOUT_MS | 5000 | Stream idle timeout in milliseconds |

### Frontend Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| VITE_API_PROXY_TARGET | http://127.0.0.1:3001 | Backend proxy URL (development only) |

## Migration Guide

### Local Development
```bash
# 1. Copy environment template
cp .env.example .env

# 2. Edit .env with your configuration
# Set DEEPINFRA_API_KEY if using real AI provider

# 3. Start services
docker compose up -d
```

### AWS Deployment
```bash
# 1. Copy and customize environment
cp .env.example .env

# 2. Set production values
export PORT=3001
export HOST=0.0.0.0
export DATABASE_URL=postgres://user:pass@rds-endpoint:5432/chatbot
export DEEPINFRA_API_KEY=your-key

# 3. Build and push images
docker build -f Dockerfile.backend -t your-ecr/chat-backend .
docker push your-ecr/chat-backend

# 4. Deploy to ECS with environment variables
# See AWS-DEPLOYMENT.md for detailed instructions
```

## Testing

### Verify Environment Variables
```bash
# Check that server uses environment variables
docker compose exec backend env | grep PORT
docker compose exec backend env | grep HOST

# Test backend connectivity
curl http://localhost:3001/api/health
```

### Test SSE Connection
```bash
# Test that SSE connections work
curl -N http://localhost:3001/api/threads/test/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "test"}]}'
```

## Backward Compatibility

All changes are backward compatible:
- Default values match previous hardcoded values
- Existing `.env` files continue to work
- Docker Compose uses defaults if variables not set

## Next Steps

1. ✅ **Completed**: Externalize all configuration
2. ⏳ **Optional**: Migrate SSE to WebSocket for better AWS compatibility
3. ⏳ **Optional**: Add health check endpoints for ECS
4. ⏳ **Optional**: Implement application-level keepalive for long streams
