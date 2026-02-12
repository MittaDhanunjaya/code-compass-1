/**
 * Phase 7.3: In-memory edit history for agent-applied changes.
 * Supports undo (revert last edit batch) and redo (re-apply undone batch).
 */

export type EditEntry = {
  path: string;
  oldContent: string;
  newContent: string;
};

/** Per-workspace history: undos stack (newest first) and redos stack. */
const undoStack = new Map<string, EditEntry[][]>();
const redoStack = new Map<string, EditEntry[][]>();

function getUndoStack(workspaceId: string): EditEntry[][] {
  if (!undoStack.has(workspaceId)) undoStack.set(workspaceId, []);
  return undoStack.get(workspaceId)!;
}

function getRedoStack(workspaceId: string): EditEntry[][] {
  if (!redoStack.has(workspaceId)) redoStack.set(workspaceId, []);
  return redoStack.get(workspaceId)!;
}

/**
 * Push a batch of edits to the undo stack. Call after applying edits.
 */
export function pushEditBatch(workspaceId: string, entries: EditEntry[]): void {
  if (entries.length === 0) return;
  getUndoStack(workspaceId).unshift(entries);
  getRedoStack(workspaceId).length = 0; // Clear redo on new edit
  // Cap undo history at 20 batches
  const stack = getUndoStack(workspaceId);
  if (stack.length > 20) stack.pop();
}

/**
 * Pop the most recent edit batch for undo. Returns the batch to revert, or null.
 */
export function popUndo(workspaceId: string): EditEntry[] | null {
  const batch = getUndoStack(workspaceId).shift();
  if (!batch) return null;
  getRedoStack(workspaceId).unshift(batch);
  return batch;
}

/**
 * Pop the most recent redo batch. Returns the batch to re-apply, or null.
 */
export function popRedo(workspaceId: string): EditEntry[] | null {
  const batch = getRedoStack(workspaceId).shift();
  if (!batch) return null;
  getUndoStack(workspaceId).unshift(batch);
  return batch;
}

/**
 * Check if undo is available.
 */
export function canUndo(workspaceId: string): boolean {
  return getUndoStack(workspaceId).length > 0;
}

/**
 * Check if redo is available.
 */
export function canRedo(workspaceId: string): boolean {
  return getRedoStack(workspaceId).length > 0;
}
