# Reasoning/Thinking Output Fix

## Problem
The chat bot was showing raw SSE data lines like:
```
data: {"type":"reasoning-delta","id":"reasoning-0","delta":" a"}
data: {"type":"reasoning-delta","id":"reasoning-0","delta":" distinction"}
```

This happened because the ai SDK v7 sends reasoning deltas by default, but the frontend wasn't handling them properly.

## Solution

### Changes Made

#### Backend (`backend/src/services/aiService/`)

1. **config.ts**: Added `enableReasoning` configuration option
   - Controlled by `ENABLE_REASONING` environment variable
   - Default: `true`

2. **submitChat.ts**: Pass `sendReasoning` option to `toUIMessageStream`
   - Now respects the `config.enableReasoning` setting

#### Frontend (`frontend/src/components/chat/`)

1. **ChatController.tsx**: Extract reasoning parts from messages
   - Added `extractReasoning()` function to pull reasoning content from message parts
   - Updated `mergeDisplayRows()` to include reasoning in `DisplayRow`

2. **ChatView.tsx**: Display reasoning in collapsible section
   - Added `reasoning?: string | null` to `DisplayRow` interface
   - Created `ReasoningBlock` component with expand/collapse toggle
   - Updated `BubbleContent` to show reasoning above the main response

### Configuration

Add to your `.env` file:

```bash
# Enable reasoning/thinking output (default: true)
# Set to 'false' to disable reasoning output completely
ENABLE_REASONING=true
```

### Features

1. **Collapsible Thinking Section**: Reasoning appears in a collapsible box above the response
2. **Character Count**: Shows the length of reasoning when collapsed
3. **Markdown Support**: Reasoning content is rendered with markdown formatting
4. **Scrollable**: Long reasoning is scrollable (max-height: 96)
5. **Configurable**: Can be disabled via environment variable

### Usage

#### Option 1: Show Thinking (Default)
```bash
ENABLE_REASONING=true
```
- Users see a "Thinking" section that can be expanded/collapsed
- Shows the model's reasoning process
- Great for understanding how the model arrived at its answer

#### Option 2: Hide Thinking
```bash
ENABLE_REASONING=false
```
- No reasoning output sent to frontend
- Cleaner, faster responses
- Less token usage visible to users

### Visual Example

When reasoning is available, messages show:

```
┌─────────────────────────────────────┐
│ ▶ Thinking          Show (256 chars)│  ← Click to expand
└─────────────────────────────────────┘

[Expanded]
┌─────────────────────────────────────┐
│ ▶ Thinking          Hide (256 chars)│
├─────────────────────────────────────┤
│ The model considers the question... │
│ It analyzes the key points...       │
│ [scrollable if long]                │
└─────────────────────────────────────┘

[Main Response]
Here's the answer to your question...
```

## Testing

1. Start the backend with `ENABLE_REASONING=true`
2. Use a model that supports reasoning (e.g., Qwen3.5, DeepSeek-R1)
3. Ask a complex question
4. You should see a "Thinking" section above the response
5. Click to expand/collapse the reasoning

## Files Modified

- `backend/src/services/aiService/config.ts`
- `backend/src/services/aiService/submitChat.ts`
- `backend/.env.example`
- `frontend/src/components/chat/ChatController.tsx`
- `frontend/src/components/chat/ChatView.tsx`

## Notes

- Reasoning tokens are still tracked in the database (`reasoning_tokens` column)
- The `MessageMetaRow` component already displays reasoning token count
- Reasoning is not persisted to the database yet (only shown during streaming)
