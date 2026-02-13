/**
 * Phase 5: Agent execute-stream hook.
 * Fetches execute-stream, parses SSE, updates result and events.
 */

import { useCallback } from "react";
import type { AgentPlan, AgentExecuteResult } from "@/lib/agent/types";
import type { AgentEvent } from "@/lib/agent-events";
import { parseApiErrorForDisplay } from "@/lib/errors";
import type { ScopeMode } from "@/lib/agent/types";

export type ModelSelection =
  | { type: "auto" }
  | { type: "model"; modelId: string; label: string }
  | { type: "group"; modelGroupId: string; label: string };

export type RunSummary = {
  editedFiles: Set<string>;
  filesSkippedDueToConflict: Set<string>;
  commandsRun: string[];
  reasoningCount: number;
  toolCallCount: number;
  toolResultCount: number;
  statusCount: number;
  isComplete: boolean;
  wasCancelled: boolean;
  scope?: { fileCount: number; approxLinesChanged: number };
  scopeMode?: ScopeMode;
  retried?: boolean;
  retryReason?: string;
  attempt1?: { testsPassed?: boolean };
  attempt2?: { testsPassed?: boolean };
};

export type UseAgentExecuteParams = {
  workspaceId: string | null;
  plan: AgentPlan | null;
  planHash?: string | null;
  modelSelection: ModelSelection;
  provider: string;
  model: string;
  scopeMode: ScopeMode;
  setPhase: (phase: "idle" | "loading_plan" | "plan_ready" | "executing" | "done") => void;
  setError: (error: string | null) => void;
  setAgentEvents: React.Dispatch<React.SetStateAction<AgentEvent[]>>;
  setRunSummary: React.Dispatch<React.SetStateAction<RunSummary | null>>;
  setExecuteResult: React.Dispatch<React.SetStateAction<AgentExecuteResult | null>>;
  setAgentReviewAccepted: React.Dispatch<React.SetStateAction<Set<string>>>;
  setProtectedPathsList: (paths: string[]) => void;
  setProtectedConfirmOpen: (open: boolean) => void;
  setAggressiveConfirmOpen: (open: boolean) => void;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  stuckTimeoutAbortRef: React.MutableRefObject<boolean>;
  lastActivityRef: React.MutableRefObject<number>;
  addLog: (entry: { type: "command" | "output" | "error" | "info"; content: string; command?: string }) => void;
  getTab: (path: string) => { path: string; content?: string } | undefined;
  updateContent: (path: string, content: string) => void;
  openFile: (path: string, content?: string) => void;
};

export function useAgentExecute(params: UseAgentExecuteParams) {
  const {
    workspaceId,
    plan,
    planHash,
    modelSelection,
    provider,
    model,
    scopeMode,
    setPhase,
    setError,
    setAgentEvents,
    setRunSummary,
    setExecuteResult,
    setAgentReviewAccepted,
    setProtectedPathsList,
    setProtectedConfirmOpen,
    setAggressiveConfirmOpen,
    abortControllerRef,
    stuckTimeoutAbortRef,
    lastActivityRef,
    addLog,
    getTab,
    updateContent,
    openFile,
  } = params;

  const doExecute = useCallback(
    async (confirmedProtectedPaths?: string[], skipProtected?: boolean, confirmedAggressive?: boolean) => {
      if (!plan || !workspaceId) return;
      if (!planHash?.trim()) {
        setError("Plan hash is required. Please re-run planning and approve again.");
        return;
      }
      setError(null);
      setAgentEvents([]);
      setRunSummary(null);
      setPhase("executing");

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const res = await fetch("/api/agent/execute-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            plan,
            planHash,
            ...(modelSelection.type === "model"
              ? { modelId: modelSelection.modelId }
              : modelSelection.type === "group"
                ? { modelGroupId: modelSelection.modelGroupId }
                : { provider, model: provider === "openrouter" ? model : undefined }),
            confirmedProtectedPaths: confirmedProtectedPaths ?? undefined,
            skipProtected: skipProtected === true,
            scopeMode: scopeMode ?? "normal",
            confirmedAggressive: confirmedAggressive === true,
          }),
          signal: abortController.signal,
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({ error: "Execute failed" }));
          const retryAfter =
            errorData.retryAfter ??
            (parseInt(res.headers.get("Retry-After") || "0", 10) || undefined);
          setError(
            parseApiErrorForDisplay(
              errorData.error || "Execute failed",
              res.status,
              retryAfter
            )
          );
          setPhase("plan_ready");
          return;
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error("Stream unavailable. The server returned an empty response. Try again.");

        let buffer = "";
        let finalResult: AgentExecuteResult | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            lastActivityRef.current = Date.now();
            buffer += decoder.decode(value, { stream: true });
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim() && line.startsWith("data: ")) {
              try {
                const jsonStr = line.slice(6).trim();
                if (!jsonStr) continue;
                const data = JSON.parse(jsonStr);
                if (data.type === "result") {
                  finalResult = data.result;
                } else if (data.type === "needProtectedConfirmation") {
                  setProtectedPathsList(data.protectedPaths || []);
                  setProtectedConfirmOpen(true);
                  setPhase("plan_ready");
                  abortControllerRef.current = null;
                  return;
                } else if (data.type === "needAggressiveConfirm") {
                  setAggressiveConfirmOpen(true);
                  setPhase("plan_ready");
                  abortControllerRef.current = null;
                  return;
                } else if (data.id && data.type && data.message) {
                  const event = data as AgentEvent;
                  setAgentEvents((prev) => [...prev, event]);
                  setRunSummary((prev) => {
                    const summary = prev || {
                      editedFiles: new Set<string>(),
                      filesSkippedDueToConflict: new Set<string>(),
                      commandsRun: [],
                      reasoningCount: 0,
                      toolCallCount: 0,
                      toolResultCount: 0,
                      statusCount: 0,
                      isComplete: false,
                      wasCancelled: false,
                    };
                    if (event.type === "reasoning") summary.reasoningCount++;
                    else if (event.type === "tool_call") summary.toolCallCount++;
                    else if (event.type === "tool_result") summary.toolResultCount++;
                    else if (event.type === "status") summary.statusCount++;
                    if (event.type === "tool_result" && event.meta?.filePath) {
                      if (event.meta.conflict) {
                        summary.filesSkippedDueToConflict.add(event.meta.filePath);
                      } else {
                        summary.editedFiles.add(event.meta.filePath);
                      }
                    }
                    if (event.type === "tool_call" && event.meta?.command) {
                      if (!summary.commandsRun.includes(event.meta.command)) {
                        summary.commandsRun.push(event.meta.command);
                      }
                    }
                    if (event.type === "status" && event.meta?.scope && typeof event.meta.scope.fileCount === "number") {
                      summary.scope = { fileCount: event.meta.scope.fileCount, approxLinesChanged: event.meta.scope.approxLinesChanged ?? 0 };
                    }
                    if (event.type === "status" && event.meta?.scopeMode) summary.scopeMode = event.meta.scopeMode as ScopeMode;
                    if (event.type === "status" && event.meta?.retried !== undefined) summary.retried = event.meta.retried;
                    if (event.type === "status" && event.meta?.retryReason) summary.retryReason = event.meta.retryReason;
                    if (event.type === "status" && event.meta?.attempt1) summary.attempt1 = event.meta.attempt1;
                    if (event.type === "status" && event.meta?.attempt2) summary.attempt2 = event.meta.attempt2;
                    if (
                      event.type === "status" &&
                      (event.message.toLowerCase().includes("complete") ||
                        event.message.toLowerCase().includes("finished") ||
                        event.message.toLowerCase().includes("done"))
                    ) {
                      summary.isComplete = true;
                    }
                    return { ...summary };
                  });
                }
              } catch {
                // Skip invalid JSON
              }
            }
          }

          if (done) {
            if (buffer.trim() && buffer.startsWith("data: ")) {
              try {
                const jsonStr = buffer.slice(6).trim();
                if (jsonStr) {
                  const data = JSON.parse(jsonStr);
                  if (data.type === "result") finalResult = data.result;
                }
              } catch {
                // Ignore parse errors
              }
            }
            break;
          }
        }

        if (!finalResult) {
          throw new Error("No result received from execution stream. The stream may have closed prematurely or the provider failed. Try again or select a different provider.");
        }

        setExecuteResult(finalResult);
        const pr = (finalResult as { pendingReview?: { fileEdits: { path: string }[] } }).pendingReview;
        if (pr?.fileEdits?.length) {
          setAgentReviewAccepted(new Set(pr.fileEdits.map((e) => e.path)));
        }

        const skippedFromResult = (finalResult as { filesSkippedDueToConflict?: string[] }).filesSkippedDueToConflict;
        setRunSummary((prev) => {
          if (!prev) return null;
          const next = { ...prev, isComplete: true };
          if (Array.isArray(skippedFromResult) && skippedFromResult.length > 0) {
            next.filesSkippedDueToConflict = new Set([...prev.filesSkippedDueToConflict, ...skippedFromResult]);
          }
          return next;
        });

        const logEntries = finalResult.log ?? [];
        for (const entry of logEntries) {
          if (entry.type === "info") {
            addLog({ type: "info", content: entry.message || "", command: undefined });
          } else if (entry.type === "command") {
            addLog({ type: "command", content: `$ ${entry.command}`, command: entry.command });
            if (entry.commandStatusSummary) {
              addLog({
                type: entry.commandStatus === "success" ? "info" : "error",
                content: `[Status: ${entry.commandStatusSummary}]`,
                command: entry.command,
              });
            }
            const message = entry.message || "";
            const lines = message.split("\n");
            let inStdout = false;
            let inStderr = false;
            let stdoutContent = "";
            let stderrContent = "";
            for (const line of lines) {
              if (line.startsWith("stdout: ")) {
                inStdout = true;
                inStderr = false;
                stdoutContent = line.substring(8);
              } else if (line.startsWith("stderr: ")) {
                inStdout = false;
                inStderr = true;
                stderrContent = line.substring(8);
              } else if (inStdout) {
                stdoutContent += (stdoutContent ? "\n" : "") + line;
              } else if (inStderr) {
                stderrContent += (stderrContent ? "\n" : "") + line;
              } else if (line.trim()) {
                addLog({
                  type: entry.status === "ok" ? "info" : "error",
                  content: line,
                  command: entry.command,
                });
              }
            }
            if (stdoutContent) addLog({ type: "output", content: stdoutContent, command: entry.command });
            if (stderrContent) addLog({ type: "error", content: stderrContent, command: entry.command });
            if (entry.autoFixAttempted && entry.secondRunSummary) {
              addLog({
                type: entry.secondRunStatus === "success" ? "info" : "error",
                content: `[Auto-fix second run: ${entry.secondRunSummary}]`,
                command: entry.command,
              });
            }
          }
        }
        if (logEntries.length > 0) {
          window.dispatchEvent(new CustomEvent("code-compass-show-terminal"));
        }

        for (const path of finalResult.filesEdited ?? []) {
          const fileRes = await fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`);
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            const content = fileData.content ?? "";
            const tab = getTab(path);
            if (tab) updateContent(path, content);
            else openFile(path, content);
          }
        }

        setPhase("done");
        window.dispatchEvent(new CustomEvent("refresh-file-tree"));
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          if (stuckTimeoutAbortRef.current) {
            stuckTimeoutAbortRef.current = false;
            setError("Request timed out. The model may have stalled. Try Rerun to try again.");
            setPhase("plan_ready");
            return;
          }
          const cancelEvent: AgentEvent = {
            id: `${Date.now()}`,
            type: "status",
            message: "Run cancelled by user",
            createdAt: new Date().toISOString(),
          };
          setAgentEvents((prev) => [...prev, cancelEvent]);
          setRunSummary((prev) =>
            prev ? { ...prev, isComplete: true, wasCancelled: true } : {
              editedFiles: new Set(),
              filesSkippedDueToConflict: new Set(),
              commandsRun: [],
              reasoningCount: 0,
              toolCallCount: 0,
              toolResultCount: 0,
              statusCount: 1,
              isComplete: true,
              wasCancelled: true,
            }
          );
          setPhase("plan_ready");
          return;
        }
        const errMsg = e instanceof Error ? e.message : "Execute failed";
        const isNetworkError = /failed to fetch|network error|load failed|network request failed|connection refused|econnrefused|econnreset|socket hang up/i.test(errMsg);
        if (isNetworkError) {
          if (process.env.NODE_ENV === "development") {
            console.error("[useAgentExecute] Network/connection error:", e);
          }
          const hint = typeof window !== "undefined" && window.location?.hostname === "localhost"
            ? ` Ensure the dev server is running (npm run dev).`
            : "";
          setError(`Connection lost during run. Check your network and try again.${hint}`);
        } else {
          setError(errMsg);
        }
        setPhase("plan_ready");
      } finally {
        abortControllerRef.current = null;
      }
    },
    [
      plan,
      workspaceId,
      provider,
      model,
      modelSelection,
      scopeMode,
      setPhase,
      setError,
      setAgentEvents,
      setRunSummary,
      setExecuteResult,
      setAgentReviewAccepted,
      setProtectedPathsList,
      setProtectedConfirmOpen,
      setAggressiveConfirmOpen,
      abortControllerRef,
      stuckTimeoutAbortRef,
      lastActivityRef,
      addLog,
      getTab,
      updateContent,
      openFile,
    ]
  );

  return { doExecute };
}
