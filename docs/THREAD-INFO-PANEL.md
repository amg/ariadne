# Thread Info Panel - Right Side Panel Implementation

## Overview

Implemented a permanent right side panel displaying thread statistics and usage information in a 3-column layout:
- **Left**: Thread sidebar (existing)
- **Center**: Chat view (existing)
- **Right**: Thread info panel (new)

## Features

### Thread Information Displayed

1. **Thread Overview**
   - Thread title
   - Created date with timestamp
   - Message count breakdown (total, user, assistant)

2. **Cost Tracking**
   - Total cost accumulated across all messages in thread
   - Displayed in micro-USD (µ) for homelab scale

3. **Token Usage Breakdown**
   - Prompt tokens
   - Completion tokens
   - Cached tokens (when available)
   - Reasoning tokens (when available)
   - Total tokens

4. **Context Window Usage**
   - Tokens used vs. model's context limit
   - Percentage bar visualization
   - Shows "unavailable" when context limit not known

5. **Primary Model**
   - Most frequently used model in the thread
   - Truncated display with full name on hover

## Architecture

### Backend

#### New Files

1. **`backend/src/services/aiService/modelConfig.ts`**
   - Model configuration registry
   - Context window limits per model
   - Pricing information (fallback)
   - `getModelConfig()` - retrieves config by model ID
   - `setModelConfig()` - updates/adds config dynamically

2. **`backend/src/services/threadSummaryService.ts`**
   - `getThreadSummary()` - computes thread statistics on-the-fly
   - Aggregates from `message_usage` table
   - Returns `ThreadSummary` interface

3. **`backend/app/routes/threads/summary.ts`**
   - GET `/api/threads/:id/summary` endpoint
   - Returns thread summary JSON
   - 404 if thread not found or unauthorized

#### Modified Files

- **`backend/app/routes/threads/index.ts`** - Added summary route export
- **`backend/app/server.ts`** - Registered summary route

### Frontend

#### New Files

1. **`frontend/src/components/layout/ThreadInfoPanel.tsx`**
   - Main panel component
   - Displays all thread statistics
   - Handles null/empty states gracefully
   - Responsive design with proper truncation

2. **`frontend/src/components/layout/index.ts`**
   - Layout folder exports

#### Modified Files

1. **`frontend/src/services/api.ts`**
   - Added `ThreadSummary` interface
   - Added `fetchThreadSummary()` function

2. **`frontend/src/components/layout/AppShell.tsx`**
   - Added `infoPanel` prop for 3-column layout

3. **`frontend/src/pages/AppLayout.tsx`**
   - Fetches thread summary on thread change
   - Passes summary and title to ThreadInfoPanel
   - Manages summary state with useEffect

## Data Flow

```
User navigates to thread
    ↓
AppLayout detects threadId change
    ↓
fetchThreadSummary() calls API
    ↓
GET /api/threads/:id/summary
    ↓
getThreadSummary() aggregates from DB
    ↓
Returns ThreadSummary object
    ↓
ThreadInfoPanel renders statistics
```

## Context Window Handling

### Priority Order

1. **Provider API** (future enhancement)
   - Fetch from provider when making inference calls
   - Update model config cache via `setModelConfig()`

2. **Local Config** (current)
   - Pre-configured in `modelConfig.ts`
   - Based on provider documentation

3. **Unavailable** (fallback)
   - Shows "Context limit unavailable"
   - Percentage bar hidden
   - Used for unknown models

### Adding New Models

Edit `backend/src/services/aiService/modelConfig.ts`:

```typescript
'model-name': {
  contextWindow: 32768,  // tokens
  pricing: { input: 0.1, output: 0.15 },  // per million tokens
},
```

## Performance Considerations

### On-the-Fly Aggregation

- **Pros**: No data duplication, always accurate, simple
- **Cons**: O(n) query per thread view, where n = message count

### Future Optimizations (if needed)

1. **Cached Summary**
   - Add `summary` JSON column to `threads` table
   - Update on message create/delete
   - Trade storage for read performance

2. **Incremental Updates**
   - Maintain running totals in thread row
   - Update incrementally on each message
   - More complex but O(1) reads

## Testing

### Manual Testing Checklist

- [ ] Navigate to different threads
- [ ] Verify summary updates on thread switch
- [ ] Check empty thread state
- [ ] Verify cost calculations
- [ ] Test with various models
- [ ] Check context percentage accuracy
- [ ] Verify responsive layout

### API Testing

```bash
# Get thread summary
curl http://localhost:3001/api/threads/<thread-uuid>/summary

# Expected response
{
  "threadId": "...",
  "totalMessages": 10,
  "userMessages": 5,
  "assistantMessages": 5,
  "totalCostUsd": "0.0012340000",
  "totalTokens": {
    "prompt": 1000,
    "completion": 500,
    "cached": 200,
    "reasoning": 100,
    "total": 1500
  },
  "primaryModel": "Qwen/Qwen3.5-9B",
  "contextUsage": {
    "used": 1500,
    "limit": 32768,
    "percentage": 4.58
  },
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

## Future Enhancements

1. **Provider Context Fetching**
   - Query provider API for model specs
   - Auto-populate unknown model configs

2. **Cost Projections**
   - Estimate remaining context budget
   - Show cost per message trend

3. **Export Functionality**
   - Export thread stats to CSV/JSON
   - Include in thread backup

4. **Comparative Analytics**
   - Compare threads side-by-side
   - Show usage trends over time

5. **Real-time Updates**
   - WebSocket for live cost updates
   - Streaming token count during generation

## Related Documentation

- [Message Usage Schema](../backend/src/db/migrations/002_message_usage.ts)
- [AI Service Config](../backend/src/services/aiService/config.ts)
- [Cost Calculation](../backend/src/services/aiService/cost.ts)
