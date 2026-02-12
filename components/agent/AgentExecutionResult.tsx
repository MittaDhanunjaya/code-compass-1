"use client";

import { Button } from "@/components/ui/button";
import { FeedbackPrompt } from "@/components/feedback-prompt";
import type { AgentExecuteResult as AgentExecuteResultType, AgentLogEntry } from "@/lib/agent/types";

type AgentExecutionResultProps = {
  executeResult: AgentExecuteResultType;
  workspaceId: string | null;
  agentReviewAccepted: Set<string>;
  agentReviewApplying: boolean;
  showAgentFeedback: boolean;
  onOpenFile: (path: string, content?: string) => void;
  onUpdateContent: (path: string, content: string) => void;
  onSetExecuteResult: React.Dispatch<React.SetStateAction<AgentExecuteResultType | null>>;
  onSetAgentReviewAccepted: React.Dispatch<React.SetStateAction<Set<string>>>;
  onSetAgentReviewApplying: (v: boolean) => void;
  onSetAgentReviewQueue: (queue: { path: string; originalContent: string; newContent: string }[]) => void;
  onSetAgentReviewIndex: (v: number) => void;
  onSetError: (msg: string | null) => void;
  onSetPendingFullFileReplaceEdits: (edits: { path: string; content: string }[]) => void;
  onSetAgentFullFileReplaceConfirmOpen: (v: boolean) => void;
  onSetPendingLargeEditEdits: (edits: { path: string; content: string }[]) => void;
  onSetAgentLargeEditConfirmOpen: (v: boolean) => void;
  onSetShowAgentFeedback: (v: boolean) => void;
};

export function AgentExecutionResult({
  executeResult,
  workspaceId,
  agentReviewAccepted,
  agentReviewApplying,
  showAgentFeedback,
  onOpenFile,
  onUpdateContent,
  onSetExecuteResult,
  onSetAgentReviewAccepted,
  onSetAgentReviewApplying,
  onSetAgentReviewQueue,
  onSetAgentReviewIndex,
  onSetError,
  onSetPendingFullFileReplaceEdits,
  onSetAgentFullFileReplaceConfirmOpen,
  onSetPendingLargeEditEdits,
  onSetAgentLargeEditConfirmOpen,
  onSetShowAgentFeedback,
}: AgentExecutionResultProps) {
  const applyEdits = async (edits: { path: string; content: string }[], confirmFullFileReplace?: boolean, confirmLargeEdit?: boolean) => {
    if (!workspaceId || edits.length === 0) return;
    onSetAgentReviewApplying(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits, confirmFullFileReplace, confirmLargeEdit }),
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

  const fileEdits = (executeResult.pendingReview?.fileEdits ?? []) as { path: string; originalContent: string; newContent: string }[];

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground">Execution log</div>
      <ul className="space-y-1 text-sm">
        {executeResult.log.map((entry: AgentLogEntry, i: number) => (
          <li
            key={i}
            className={`flex items-start gap-2 ${
              entry.type === "info"
                ? "text-muted-foreground italic"
                : entry.status === "ok"
                  ? "text-green-700 dark:text-green-400"
                  : entry.status === "error"
                    ? "text-destructive"
                    : "text-muted-foreground"
            }`}
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">[{entry.stepIndex + 1}]</span>
            {entry.actionLabel != null && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                  entry.actionLabel === "EDIT"
                    ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
                    : entry.actionLabel === "CMD-SETUP"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : entry.actionLabel === "CMD-TEST"
                        ? "bg-purple-500/15 text-purple-700 dark:text-purple-400"
                        : entry.actionLabel === "AUTO-FIX"
                          ? "bg-orange-500/15 text-orange-700 dark:text-orange-400"
                          : "bg-muted text-muted-foreground"
                }`}
              >
                {entry.actionLabel}
              </span>
            )}
            <span className="min-w-0">{entry.statusLine ?? entry.message}</span>
          </li>
        ))}
      </ul>
      <div className="border-t border-border pt-2 text-sm">
        <div className="font-medium text-muted-foreground">Completion summary</div>
        <p className="mt-1">{executeResult.summary}</p>
        {executeResult.sandboxChecks && (
          <div className="mt-2 rounded border border-border bg-muted/30 p-2 text-xs">
            <div className="font-medium mb-1">Sandbox checks:</div>
            <div className="space-y-1">
              <div className="flex items-start gap-2">
                <span>Lint:</span>
                <div className="flex-1">
                  <span
                    className={`font-mono ${
                      executeResult.sandboxChecks.lint?.status === "passed"
                        ? "text-green-600 dark:text-green-400"
                        : executeResult.sandboxChecks.lint?.status === "failed"
                          ? "text-red-600 dark:text-red-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {executeResult.sandboxChecks.lint?.status === "passed"
                      ? "✓ passed"
                      : executeResult.sandboxChecks.lint?.status === "failed"
                        ? "✗ failed"
                        : executeResult.sandboxChecks.lint?.status === "skipped"
                          ? "⊘ skipped"
                          : "○ not configured"}
                  </span>
                  {executeResult.sandboxChecks.lint?.logs && executeResult.sandboxChecks.lint?.status === "failed" && (
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-20 overflow-y-auto">
                      {executeResult.sandboxChecks.lint.logs}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span>Tests:</span>
                <div className="flex-1">
                  <span
                    className={`font-mono ${
                      executeResult.sandboxChecks.tests?.status === "passed"
                        ? "text-green-600 dark:text-green-400"
                        : executeResult.sandboxChecks.tests?.status === "failed"
                          ? "text-red-600 dark:text-red-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {executeResult.sandboxChecks.tests?.status === "passed"
                      ? "✓ passed"
                      : executeResult.sandboxChecks.tests?.status === "failed"
                        ? "✗ failed"
                        : executeResult.sandboxChecks.tests?.status === "skipped"
                          ? "⊘ skipped"
                          : "○ not configured"}
                  </span>
                  {executeResult.sandboxChecks.tests?.logs && executeResult.sandboxChecks.tests?.status === "failed" && (
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-20 overflow-y-auto">
                      {executeResult.sandboxChecks.tests.logs}
                    </div>
                  )}
                </div>
              </div>
              {executeResult.sandboxChecks.run && (
                <div className="flex items-start gap-2">
                  <span>Run:</span>
                  <div className="flex-1">
                    <span
                      className={`font-mono ${
                        executeResult.sandboxChecks.run.status === "passed"
                          ? "text-green-600 dark:text-green-400"
                          : executeResult.sandboxChecks.run.status === "failed"
                            ? "text-red-600 dark:text-red-400"
                            : "text-muted-foreground"
                      }`}
                    >
                      {executeResult.sandboxChecks.run.status === "passed"
                        ? "✓ passed"
                        : executeResult.sandboxChecks.run.status === "failed"
                          ? "✗ failed"
                          : executeResult.sandboxChecks.run.status === "skipped"
                            ? "⊘ skipped"
                            : "○ not configured"}
                    </span>
                    {executeResult.sandboxChecks.run.logs && executeResult.sandboxChecks.run.status === "failed" && (
                      <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-20 overflow-y-auto">
                        {executeResult.sandboxChecks.run.logs}
                      </div>
                    )}
                    {executeResult.sandboxChecks.run.port && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">Running on port {executeResult.sandboxChecks.run.port}</div>
                    )}
                  </div>
                </div>
              )}
              {executeResult.pendingReview ? (
                <p className="text-amber-600 dark:text-amber-400 mt-1 italic text-[11px] font-medium">
                  Review your changes below. Accept or reject each file, then click Apply accepted.
                </p>
              ) : executeResult.sandboxChecks.run && executeResult.sandboxChecks.run.status === "failed" ? (
                <p className="text-red-600 dark:text-red-400 mt-1 italic text-[11px] font-medium">
                  ✗ CRITICAL: Application failed to run. Changes were NOT applied. Please fix errors and try again.
                </p>
              ) : executeResult.sandboxChecks.lint?.status === "failed" || executeResult.sandboxChecks.tests?.status === "failed" ? (
                <p className="text-amber-600 dark:text-amber-400 mt-1 italic text-[11px]">
                  Sandbox checks failed (lint/tests), but application runs. Review the errors above.
                </p>
              ) : executeResult.sandboxChecks.lint?.status === "passed" &&
                executeResult.sandboxChecks.tests?.status === "passed" &&
                (!executeResult.sandboxChecks.run || executeResult.sandboxChecks.run.status === "passed") ? (
                <p className="text-green-600 dark:text-green-400 mt-1 italic text-[11px]">
                  ✓ All checks passed. Application verified working. Review and apply below.
                </p>
              ) : executeResult.sandboxChecks.run && executeResult.sandboxChecks.run.status === "passed" ? (
                <p className="text-green-600 dark:text-green-400 mt-1 italic text-[11px]">
                  ✓ Application runs successfully. Review and apply below.
                </p>
              ) : (
                <p className="text-muted-foreground mt-1 italic text-[11px]">
                  Sandbox checks skipped/not configured. Review and apply below.
                </p>
              )}
            </div>
          </div>
        )}
        {fileEdits.length > 0 && workspaceId && (
          <div className="mt-3 rounded border border-border bg-muted/20 p-2 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Review edits before applying (Phase F)</p>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                variant="default"
                className="text-xs"
                onClick={() => {
                  onSetAgentReviewQueue([...fileEdits]);
                  onSetAgentReviewIndex(0);
                  onSetAgentReviewAccepted(new Set());
                }}
              >
                Review each file in diff
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Or accept/reject per file below, then Apply accepted.</p>
            <ul className="space-y-1.5 max-h-48 overflow-y-auto">
              {fileEdits.map((edit, idx) => (
                <li key={`${edit.path}-${idx}`} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={agentReviewAccepted.has(edit.path)}
                    onChange={() => {
                      onSetAgentReviewAccepted((prev) => {
                        const next = new Set(prev);
                        if (next.has(edit.path)) next.delete(edit.path);
                        else next.add(edit.path);
                        return next;
                      });
                    }}
                    className="rounded border-border"
                  />
                  <span className="font-mono truncate flex-1" title={edit.path}>
                    {edit.path}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => onOpenFile(edit.path, edit.newContent ?? edit.originalContent ?? "")}
                    title="Open file"
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              className="w-full"
              disabled={agentReviewApplying || agentReviewAccepted.size === 0}
              onClick={() => applyEdits(fileEdits.filter((e) => agentReviewAccepted.has(e.path)).map((e) => ({ path: e.path, content: e.newContent })))}
            >
              {agentReviewApplying ? "Applying…" : `Apply accepted (${agentReviewAccepted.size})`}
            </Button>
          </div>
        )}
        {executeResult.filesEdited?.length > 0 && !executeResult.pendingReview ? (
          <div className="mt-2 space-y-1">
            <p className="font-medium text-muted-foreground">
              Files created/modified ({executeResult.filesEdited.length}):
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
              {executeResult.filesEdited.map((path, idx) => (
                <li key={`${path}-${idx}`} className="font-mono text-xs">
                  {path}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              💡 Files are saved in your workspace. Check the file tree on the left (refresh if needed).
            </p>
            {showAgentFeedback && (
              <FeedbackPrompt
                source="agent"
                workspaceId={workspaceId}
                onSubmitted={() => onSetShowAgentFeedback(false)}
                className="mt-2"
              />
            )}
          </div>
        ) : executeResult.sandboxChecks?.run?.status === "failed" ? (
          <div className="mt-2 space-y-1">
            <p className="text-red-600 dark:text-red-400 text-xs font-medium">
              ⚠️ No changes were applied because the application failed to run. Please review the errors above and fix them before trying again.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
