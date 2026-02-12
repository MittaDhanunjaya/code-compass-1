"use client";

import { InlineEditDiffDialog } from "@/components/inline-edit-diff-dialog";
import type { AgentExecuteResult } from "@/lib/agent/types";

type ReviewItem = { path: string; originalContent: string; newContent: string };

type AgentReviewQueueProps = {
  queue: ReviewItem[];
  index: number;
  workspaceId: string | null;
  agentReviewAccepted: Set<string>;
  fileEdits: ReviewItem[];
  onSetAgentReviewAccepted: React.Dispatch<React.SetStateAction<Set<string>>>;
  onSetAgentReviewQueue: (queue: ReviewItem[]) => void;
  onSetAgentReviewIndex: (v: number) => void;
  onSetAgentReviewApplying: (v: boolean) => void;
  onSetExecuteResult: React.Dispatch<React.SetStateAction<AgentExecuteResult | null>>;
  onUpdateContent: (path: string, content: string) => void;
  onSetError: (msg: string | null) => void;
  onSetPendingFullFileReplaceEdits: (edits: { path: string; content: string }[]) => void;
  onSetAgentFullFileReplaceConfirmOpen: (v: boolean) => void;
  onSetPendingLargeEditEdits: (edits: { path: string; content: string }[]) => void;
  onSetAgentLargeEditConfirmOpen: (v: boolean) => void;
};

export function AgentReviewQueue({
  queue,
  index,
  workspaceId,
  agentReviewAccepted,
  fileEdits,
  onSetAgentReviewAccepted,
  onSetAgentReviewQueue,
  onSetAgentReviewIndex,
  onSetAgentReviewApplying,
  onSetExecuteResult,
  onUpdateContent,
  onSetError,
  onSetPendingFullFileReplaceEdits,
  onSetAgentFullFileReplaceConfirmOpen,
  onSetPendingLargeEditEdits,
  onSetAgentLargeEditConfirmOpen,
}: AgentReviewQueueProps) {
  const current = queue[index];
  if (!current || !workspaceId) return null;

  const applyEdits = async (edits: { path: string; content: string }[]) => {
    if (!workspaceId || edits.length === 0) return;
    onSetAgentReviewApplying(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 400 && Array.isArray(data.fullFileReplacePaths) && data.fullFileReplacePaths.length > 0) {
          onSetPendingFullFileReplaceEdits(edits);
          onSetAgentFullFileReplaceConfirmOpen(true);
          return;
        }
        if (res.status === 400 && Array.isArray(data.largeEditPaths) && data.largeEditPaths.length > 0) {
          onSetPendingLargeEditEdits(edits);
          onSetAgentLargeEditConfirmOpen(true);
          return;
        }
        throw new Error(data.error || "Failed to apply edits");
      }
      for (const e of edits) onUpdateContent(e.path, e.content);
      onSetExecuteResult((prev) => {
        if (!prev) return prev;
        const next = { ...prev, filesEdited: [...(prev.filesEdited ?? []), ...edits.map((x) => x.path)] };
        delete (next as Record<string, unknown>).pendingReview;
        return next;
      });
    } catch (e) {
      onSetError(e instanceof Error ? e.message : "Failed to apply edits");
    } finally {
      onSetAgentReviewApplying(false);
    }
  };

  return (
    <InlineEditDiffDialog
      key={`${current.path}-${index}`}
      open={true}
      onOpenChange={(open) => {
        if (!open) {
          onSetAgentReviewQueue([]);
          onSetAgentReviewIndex(0);
        }
      }}
      path={current.path}
      originalContent={current.originalContent}
      newContent={current.newContent}
      workspaceId={workspaceId}
      applyOnAccept={false}
      onAccept={async () => {
        const acceptedPaths = new Set(agentReviewAccepted);
        acceptedPaths.add(current.path);
        onSetAgentReviewAccepted(acceptedPaths);
        const nextIndex = index + 1;
        if (nextIndex >= queue.length) {
          onSetAgentReviewQueue([]);
          onSetAgentReviewIndex(0);
          const edits = fileEdits.filter((e) => acceptedPaths.has(e.path)).map((e) => ({ path: e.path, content: e.newContent }));
          if (edits.length > 0) await applyEdits(edits);
        } else {
          onSetAgentReviewIndex(nextIndex);
        }
      }}
      onReject={() => {
        const nextIndex = index + 1;
        if (nextIndex >= queue.length) {
          onSetAgentReviewQueue([]);
          onSetAgentReviewIndex(0);
          if (agentReviewAccepted.size > 0) {
            const edits = fileEdits.filter((e) => agentReviewAccepted.has(e.path)).map((e) => ({ path: e.path, content: e.newContent }));
            if (edits.length > 0) applyEdits(edits);
          }
        } else {
          onSetAgentReviewIndex(nextIndex);
        }
      }}
    />
  );
}
