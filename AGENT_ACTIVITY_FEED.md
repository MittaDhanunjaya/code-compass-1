# Agent Activity Feed Implementation

## Overview
The Agent Activity Feed provides real-time visibility into what the agent is doing during planning and execution phases. Users can see the agent's reasoning, tool calls, and results as they happen.

## Architecture

### 1. Event Type Definition (`lib/agent-events.ts`)
- **AgentEventType**: `'reasoning' | 'tool_call' | 'tool_result' | 'status'`
- **AgentEvent Interface**:
  - `id`: Unique identifier
  - `type`: Event type
  - `message`: Human-readable text
  - `meta`: Optional metadata (toolName, filePath, command, stepIndex)
  - `createdAt`: ISO timestamp

### 2. Backend Streaming

#### Planning Phase (`app/api/agent/plan-stream/route.ts`)
- Uses Server-Sent Events (SSE) via `ReadableStream`
- Emits events during:
  - **Status**: "Agent started planning...", "Planning complete"
  - **Reasoning**: Model's thinking process (extracted from streaming tokens)
  - **Tool calls**: "Searching codebase index...", "Reading file X..."
  - **Tool results**: "Found N relevant files", "Read N file(s)..."

#### Execution Phase (`app/api/agent/execute-stream/route.ts`)
- Emits events during:
  - **Status**: "Agent execution started...", "Execution complete"
  - **Reasoning**: "Auto-fixing failed tests..."
  - **Tool calls**: "Editing file X", "Running command: Y"
  - **Tool results**: "Applied edit to X", "Command succeeded/failed"

### 3. Frontend Display (`components/agent-panel.tsx`)
- Subscribes to SSE stream from `/api/agent/plan-stream` and `/api/agent/execute-stream`
- Maintains `agentEvents` state array
- Renders activity feed with:
  - Color-coded event types
  - Icons for visual distinction
  - File paths and commands in monospace
  - Auto-scroll to newest events
  - Event count indicator

### 4. Model Prompting
The system prompt (`PLAN_SYSTEM`) instructs the model to:
- Emit short, user-friendly status messages during planning
- Describe what it's actively doing or thinking about
- Keep messages concise and focused

## Event Flow

```
User clicks "Start"
    ↓
Frontend calls /api/agent/plan-stream
    ↓
Backend starts streaming:
  - Status: "Agent started planning..."
  - Reasoning: "Checking API keys..."
  - Tool call: "Searching codebase index..."
  - Tool result: "Found 3 relevant files"
  - Reasoning: "Generating plan..."
  - Status: "Planning complete"
    ↓
Frontend receives events → Updates agentEvents state → Renders in UI
    ↓
User approves plan → Frontend calls /api/agent/execute-stream
    ↓
Backend streams execution events:
  - Status: "Agent execution started..."
  - Tool call: "Editing file app.py"
  - Tool result: "Applied edit to app.py"
  - Tool call: "Running command: python test.py"
  - Tool result: "Tests passed: 12, failed: 0"
  - Status: "Execution complete"
```

## Features

✅ **Real-time streaming** - Events appear as they happen
✅ **Multiple event types** - Reasoning, tool calls, results, status
✅ **Rich metadata** - File paths, commands, tool names
✅ **Auto-scroll** - Always shows latest activity
✅ **Cancel support** - AbortController cancels streams
✅ **Visual indicators** - Colors and icons for each event type
✅ **No hardcoded steps** - All events come from actual agent activity

## Event Types

### Reasoning (`reasoning`)
- Model's internal thinking/planning messages
- Example: "Analyzing existing codebase structure..."
- Color: Blue

### Tool Call (`tool_call`)
- When agent invokes a tool (read file, run command, etc.)
- Example: "Reading file src/app/page.tsx"
- Color: Purple

### Tool Result (`tool_result`)
- Outcome of a tool invocation
- Example: "Applied edit to app.py" or "Command succeeded"
- Color: Green

### Status (`status`)
- High-level status updates
- Example: "Agent started planning...", "Planning complete"
- Color: Muted

## API Endpoints

### POST `/api/agent/plan-stream`
- **Request**: `{ instruction, workspaceId, provider, model, fileList, useIndex }`
- **Response**: SSE stream of AgentEvent objects + final plan
- **Format**: `data: <JSON>\n\n`

### POST `/api/agent/execute-stream`
- **Request**: `{ workspaceId, plan, provider, model, confirmedProtectedPaths }`
- **Response**: SSE stream of AgentEvent objects + final result
- **Format**: `data: <JSON>\n\n`

## UI Components

### Agent Activity Feed
- Located in `components/agent-panel.tsx`
- Visible during `loading_plan` and `executing` phases
- Scrollable container (max-height: 16rem)
- Shows event count
- Auto-scrolls to bottom

### Cancel Button
- Located next to status indicator
- Uses `AbortController` to cancel active streams
- Emits final status event: "Run cancelled by user"

## Files Modified/Created

1. **lib/agent-events.ts** - Event type definitions
2. **app/api/agent/plan-stream/route.ts** - Planning event emission
3. **app/api/agent/execute-stream/route.ts** - Execution event emission
4. **components/agent-panel.tsx** - Frontend display and subscription

## Future Enhancements

- [ ] Collapsible activity feed
- [ ] Filter by event type
- [ ] Export activity log
- [ ] Search within events
- [ ] Performance metrics (time per step)
