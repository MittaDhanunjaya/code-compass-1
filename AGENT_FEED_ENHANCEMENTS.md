# Agent Activity Feed Enhancements

## Overview
Two enhancements to the Agent Activity Feed:
1. **Clickable file paths** - Jump from log events to file diffs/editor
2. **End-of-run summary** - Automatic summary built from events

## Implementation Details

### 1. Clickable File Paths

#### Event Detection
- Events with `meta.filePath` are detected as file-related events
- Currently, these are `tool_result` events from file edits during execution
- Example event:
  ```typescript
  {
    type: 'tool_result',
    message: 'Applied edit to src/app/page.tsx',
    meta: { filePath: 'src/app/page.tsx', toolName: 'edit_file' }
  }
  ```

#### Click Handler (`handleFileClick`)
- Fetches file content from `/api/workspaces/${workspaceId}/files?path=${filePath}`
- Opens file in editor:
  - If file is already open: switches to that tab and updates content
  - If file is not open: opens new tab with file content
- Refreshes file tree to highlight the file
- Fails silently if file cannot be opened (logs warning to console)

#### UI Changes
- File paths in activity feed are rendered as clickable buttons
- Styled with underline and hover effect
- Tooltip: "Open this file"
- Monospace font for file paths

### 2. End-of-Run Summary

#### State Tracking (`runSummary`)
Tracks aggregates during streaming:
- `editedFiles`: `Set<string>` - unique file paths from `tool_result` events with `meta.filePath`
- `commandsRun`: `string[]` - unique commands from `tool_call` events with `meta.command`
- `reasoningCount`: number of `reasoning` events
- `toolCallCount`: number of `tool_call` events
- `toolResultCount`: number of `tool_result` events
- `statusCount`: number of `status` events
- `isComplete`: boolean - true when run finishes
- `wasCancelled`: boolean - true if user cancelled

#### Event Detection
- **File edits**: `tool_result` events with `meta.filePath`
- **Commands**: `tool_call` events with `meta.command`
- **Completion**: Detected when:
  - Stream closes normally (done = true)
  - Final `status` event contains "complete", "finished", or "done"
  - User cancels (sets `wasCancelled: true`)

#### Summary Display
Shown when:
- `runSummary.isComplete === true`
- Phase is `"done"` (execution completed) OR `"plan_ready"` with `wasCancelled === true` (execution cancelled)

Content:
- **Edited files**: Shows count and up to 5 clickable file links (same click handler as activity feed)
- **Commands run**: Shows count and first 3 commands
- **Event statistics**: Total events with breakdown by type
- **Cancellation indicator**: Shows "(Cancelled)" label if run was cancelled

#### Design
- Subtle border-top separator from activity feed
- Compact, read-only display
- Clickable file links use same styling as activity feed
- Automatically updated as events stream in

## Files Modified

### `components/agent-panel.tsx`
1. Added `runSummary` state to track aggregates
2. Added `handleFileClick` callback to open files
3. Updated `startPlan` to reset summary
4. Updated `doExecute` to reset summary and track events
5. Enhanced event handlers to update summary aggregates
6. Made file paths clickable in activity feed UI
7. Added run summary UI component

## Event Types Used

### For File Edits
- **Type**: `tool_result`
- **Condition**: `event.meta?.filePath` exists
- **Source**: Backend emits these when files are edited during execution
- **Example**: `{ type: 'tool_result', message: 'Applied edit to app.py', meta: { filePath: 'app.py', toolName: 'edit_file' } }`

### For Commands
- **Type**: `tool_call`
- **Condition**: `event.meta?.command` exists
- **Source**: Backend emits these when commands are run
- **Example**: `{ type: 'tool_call', message: 'Running command: npm test', meta: { command: 'npm test', toolName: 'run_command' } }`

## User Experience

### Clicking File Paths
1. User sees "Applied edit to src/app/page.tsx" in activity feed
2. File path is underlined and clickable
3. User clicks → file opens in editor
4. File tree refreshes to highlight the file
5. If file was already open, switches to that tab

### Viewing Summary
1. After execution completes, summary appears below activity feed
2. Shows:
   - "Edited 3 file(s): [clickable links]"
   - "Ran 2 command(s): npm install, npm test"
   - "Total events: 15 (reasoning: 5, tools: 4, results: 6)"
3. User can click file links to open them
4. If cancelled, shows "(Cancelled)" label but still displays partial summary

## Backend Events (No Changes Required)

The backend already emits the necessary events:
- File edits: `/api/agent/execute-stream` emits `tool_result` events with `meta.filePath`
- Commands: `/api/agent/execute-stream` emits `tool_call` events with `meta.command`
- Status: Both streams emit `status` events for completion

No backend changes were needed - all information comes from existing events.
