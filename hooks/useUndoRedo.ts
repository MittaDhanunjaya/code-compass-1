/**
 * Phase 7.3: Hook for agent edit undo/redo.
 */

import { useState, useCallback, useEffect } from "react";

export function useUndoRedo(
  workspaceId: string | null,
  onUpdateContent: (path: string, content: string) => void
): { canUndo: boolean; canRedo: boolean; undo: () => Promise<void>; redo: () => Promise<void>; refetch: () => Promise<void> } {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const refetch = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/undo`);
      if (res.ok) {
        const data = await res.json();
        setCanUndo(data.canUndo ?? false);
        setCanRedo(data.canRedo ?? false);
      }
    } catch {
      // Ignore
    }
  }, [workspaceId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const undo = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/undo`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Undo failed");
      setCanUndo(data.canUndo ?? false);
      setCanRedo(data.canRedo ?? false);
      for (const { path, content } of data.reverted ?? []) {
        onUpdateContent(path, content);
      }
    } catch {
      // Ignore
    }
  }, [workspaceId, onUpdateContent]);

  const redo = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/redo`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Redo failed");
      setCanUndo(data.canUndo ?? false);
      setCanRedo(data.canRedo ?? false);
      for (const { path, content } of data.reapplied ?? []) {
        onUpdateContent(path, content);
      }
    } catch {
      // Ignore
    }
  }, [workspaceId, onUpdateContent]);

  return { canUndo, canRedo, undo, redo, refetch };
}
