"use client";

import { useState, useEffect } from "react";

export type WorkspaceLabel = {
  name: string;
  branch: string | null;
};

export function useWorkspaceLabel(workspaceId: string | null): WorkspaceLabel | null {
  const [label, setLabel] = useState<WorkspaceLabel | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setLabel(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [wsRes, gitRes] = await Promise.all([
          fetch(`/api/workspaces/${workspaceId}`),
          fetch(`/api/workspaces/${workspaceId}/git/status`).catch(() => null),
        ]);
        if (cancelled) return;
        const ws = wsRes.ok ? await wsRes.json() : null;
        const git = gitRes?.ok ? await gitRes.json() : null;
        const name = ws?.name ?? "Workspace";
        const branch = git?.currentBranch ?? ws?.github_current_branch ?? null;
        setLabel({ name, branch });
      } catch {
        if (!cancelled) setLabel({ name: "Workspace", branch: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return label;
}
