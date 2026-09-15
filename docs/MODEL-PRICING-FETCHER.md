# Model Pricing Fetcher - Live Provider API Integration

## Overview

Replaced hardcoded model configurations with a dynamic system that:
1. **Fetches live pricing** from DeepInfra provider API
2. **Caches in database** (`model_configs` table)
3. **Fallback config** for critical model when DB unavailable
4. **Manual refresh** button in UI to update pricing

## Architecture

### Data Flow

```
User clicks refresh button
    ↓
POST /api/models/refresh
    ↓
fetchDeepInfraModels() → https://api.deepinfra.com/models/list
    ↓
Parse & upsert to model_configs table
    ↓
Return count of updated models
    ↓
UI shows success + refreshes thread summary
```

### Database Schema

**Table:** `model_configs`

| Column | Type | Description |
|--------|------|-------------|
| `model_id` | text (PK) | Model identifier (e.g., "Qwen/Qwen3.5-9B") |
| `provider` | text | Provider name ("deepinfra") |
| `context_window` | integer | Context limit in tokens |
| `input_price_per_million` | real | Input token price per 1M tokens |
| `output_price_per_million` | real | Output token price per 1M tokens |
| `supports_caching` | boolean | Whether model supports KV caching |
| `last_updated` | timestamptz | When config was last refreshed |

### API Endpoints

#### POST `/api/models/refresh`

Refreshes all model configs from DeepInfra API.

**Response:**
```json
{
  "success": true,
  "modelsUpdated": 150
}
```

**Error:**
```json
{
  "error": "Failed to fetch from DeepInfra API",
  "modelsUpdated": 0
}
```

### Services

#### `modelConfigService.ts`

| Function | Description |
|----------|-------------|
| `fetchDeepInfraModels()` | Fetches model list from provider API |
| `refreshModelConfigs()` | Fetches + upserts to DB |
| `getModelConfig(modelId)` | Gets config from DB (with fallback) |
| `getModelConfigs(modelIds[])` | Gets multiple configs |
| `listModelConfigs()` | Lists all cached configs |
| `cleanupModelConfigs(keepIds)` | Removes unused configs |

#### `aiService/modelConfig.ts` (Fallback Only)

```typescript
// ONLY fallback - DB is primary source
const FALLBACK_CONFIG = {
  model_id: 'Qwen/Qwen3.5-9B',
  context_window: 32768,
  pricing: { input: 0.1, output: 0.15 },
};
```

## UI Features

### Thread Info Panel

**Refresh Button:**
- Located next to "Primary Model" section
- Shows spinner animation while refreshing
- Disabled when no model selected
- Refetches thread summary after refresh

**Visual States:**
- Idle: RefreshCw icon (static)
- Loading: RefreshCw icon (spinning)
- Success: Context limit updates (if model changed)
- Error: Console log (future: toast notification)

## DeepInfra API

### Endpoint

```bash
GET https://api.deepinfra.com/models/list
```

### Response Format

```json
[
  {
    "_id": "...",
    "name": "Qwen/Qwen3.5-9B",
    "organization": "Qwen",
    "context_length": 32768,
    "pricing": {
      "prompt": "0.0000001",
      "completion": "0.00000015"
    },
    "capabilities": {
      "chat_completion": true,
      "caching": false
    }
  }
]
```

### Price Conversion

API returns price **per token** → We store **per million tokens**:

```typescript
const inputPrice = model.pricing.prompt
  ? parseFloat(model.pricing.prompt) * 1_000_000
  : null;
```

## Migration

### Apply Migration

```bash
cd /workspace/alex-chat-bot/backend
npm run migrate
```

### Rollback

```bash
npm run migrate down
```

## Usage

### Manual Refresh (UI)

1. Open any thread
2. Look at right side panel
3. Click refresh icon next to model name
4. Wait for spinner to complete
5. Context limit updates if model config changed

### Programmatic Refresh

```typescript
import { refreshModelPricing } from '@/services/api';

const result = await refreshModelPricing();
console.log(`Updated ${result.modelsUpdated} models`);
```

### Fetch Single Model Config

```typescript
import { getModelConfig } from '@services/modelConfigService';

const config = await getModelConfig('Qwen/Qwen3.5-9B');
console.log(config?.context_window); // 32768
console.log(config?.input_price_per_million); // 0.1
```

## Benefits

### Before (Hardcoded)

❌ Manual updates for price changes  
❌ No context window for new models  
❌ Code changes required  
❌ Risk of outdated pricing  

### After (Live Fetch)

✅ Automatic price updates from provider  
✅ Context windows for all models  
✅ One-click refresh  
✅ Always current pricing  
✅ DB cache for performance  
✅ Fallback for reliability  

## Future Enhancements

1. **Auto-refresh on startup**
   - Fetch latest pricing when server starts
   - Daily scheduled refresh (cron job)

2. **Multi-provider support**
   - Abstract provider interface
   - Support OpenRouter, Together, etc.
   - Provider selection per model

3. **Price history tracking**
   - Store historical prices
   - Show price trend charts
   - Alert on price changes

4. **Model capability filtering**
   - Filter by context window size
   - Filter by caching support
   - Filter by modality (text/image)

5. **UI improvements**
   - Toast notifications on refresh
   - Show last updated timestamp
   - List all available models
   - Compare models side-by-side

## Testing

### Manual Testing

```bash
# 1. Start backend
cd /workspace/alex-chat-bot/backend
npm run dev

# 2. Start frontend
cd /workspace/alex-chat-bot/frontend
npm run dev

# 3. Test refresh endpoint
curl -X POST http://localhost:3001/api/models/refresh

# Expected response
# {"success":true,"modelsUpdated":150}

# 4. Test in UI
# - Navigate to any thread
# - Click refresh icon in right panel
# - Watch spinner animation
# - Verify context limit updates
```

### API Testing

```bash
# Get all cached models
curl http://localhost:3001/api/models/list

# Refresh pricing
curl -X POST http://localhost:3001/api/models/refresh

# Get specific model config
curl http://localhost:3001/api/models/Qwen/Qwen3.5-9B
```

## Troubleshooting

### "Failed to fetch from DeepInfra API"

**Causes:**
- Network connectivity issues
- DeepInfra API downtime
- Rate limiting

**Solutions:**
- Check network connectivity
- Retry after a few minutes
- Fallback config will be used

### Context limit still shows "unavailable"

**Causes:**
- Model not in DeepInfra API response
- Provider doesn't report context_length

**Solutions:**
- Click refresh button to fetch latest
- Check if model exists in DB: 
  ```sql
  SELECT * FROM model_configs WHERE model_id = '...';
  ```
- Add manual config if needed

### Models not caching

**Check:**
```sql
SELECT model_id, supports_caching 
FROM model_configs 
WHERE supports_caching = true;
```

## Related Files

- **Migration:** `backend/src/db/migrations/003_model_configs.ts`
- **Service:** `backend/src/services/modelConfigService.ts`
- **Fallback:** `backend/src/services/aiService/modelConfig.ts`
- **Route:** `backend/app/routes/models/refresh.ts`
- **UI Component:** `frontend/src/components/layout/ThreadInfoPanel.tsx`
- **API Client:** `frontend/src/services/api.ts`
