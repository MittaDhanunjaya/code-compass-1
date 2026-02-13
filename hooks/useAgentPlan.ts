/**
 * Phase 5: Agent plan streaming hook.
 * Fetches plan-stream, parses SSE, updates plan and events.
 */

import { useCallback, useRef, useState } from "react";
import type { AgentPlan, PlanStep, FileEditStep, CommandStep } from "@/lib/agent/types";
import type { AgentEvent } from "@/lib/agent-events";
import type { ProviderId } from "@/lib/llm/providers";
import { PROVIDER_LABELS } from "@/lib/llm/providers";
import { parseApiErrorForDisplay } from "@/lib/errors";
import type { ScopeMode } from "@/lib/agent/types";

export type ModelSelection =
  | { type: "auto" }
  | { type: "model"; modelId: string; label: string }
  | { type: "group"; modelGroupId: string; label: string };

export type PlanDebugInfo = {
  modelUsed: string;
  tokensReserved: number;
  tokensUsed: { input?: number; output?: number; total?: number } | null;
  providerErrors: string[];
  fallbackReason: "rate_limit" | "capability" | null;
  streamDurationMs: number;
};

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

export type UseAgentPlanParams = {
  workspaceId: string | null;
  instruction: string;
  /** Previous plan for drift detection (same goal re-run). */
  previousPlan?: AgentPlan | null;
  provider: ProviderId;
  model: string;
  modelSelection: ModelSelection;
  scopeMode: ScopeMode;
  fetchFileList: () => Promise<string[]>;
  onPlan: (plan: AgentPlan | null) => void;
  setPlanHash?: (hash: string | null) => void;
  setModelsExhaustedModal?: (data: { recommendedProviders: string[]; recommendedModels: string[] } | null) => void;
  onPhase: (phase: "idle" | "loading_plan" | "plan_ready") => void;
  onError: (error: string | null) => void;
  /** @deprecated Use setAgentEvents - kept for backward compatibility */
  onAgentEvents?: (events: AgentEvent[]) => void;
  setAgentEvents: React.Dispatch<React.SetStateAction<AgentEvent[]>>;
  setRunSummary: React.Dispatch<React.SetStateAction<RunSummary | null>>;
  setPlanContextUsed: (paths: string[] | null) => void;
  setRunScope: (scope: { fileCount: number; approxLinesChanged: number } | null) => void;
  setPlanUsage: (usage: string | null) => void;
  setModelFallbackBanner: (banner: { from: string; to: string; reason?: "rate_limit" | "capability"; availableFreeModels: { id: string; label: string }[] } | null) => void;
  setPlanRetryBanner?: (banner: { message: string } | null) => void;
  setPlanDebugInfo: (info: PlanDebugInfo | null) => void;
  lastActivityRef: React.MutableRefObject<number>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  stuckTimeoutAbortRef: React.MutableRefObject<boolean>;
  onAutoRetry: (startPlan: () => Promise<void>) => void;
};

export function useAgentPlan(params: UseAgentPlanParams) {
  const {
    workspaceId,
    instruction,
    previousPlan,
    provider,
    model,
    modelSelection,
    scopeMode,
    fetchFileList,
    onPlan,
    setPlanHash,
    setModelsExhaustedModal,
    onPhase,
    onError,
    setAgentEvents,
    setRunSummary,
    setPlanContextUsed,
    setRunScope,
    setPlanUsage,
    setModelFallbackBanner,
    setPlanRetryBanner,
    setPlanDebugInfo,
    lastActivityRef,
    abortControllerRef,
    stuckTimeoutAbortRef,
    onAutoRetry,
  } = params;

  const autoRetryCountRef = useRef(0);
  const [budgetExceededModal, setBudgetExceededModal] = useState<{ message: string; scope: "user" | "workspace" } | null>(null);

  const startPlan = useCallback(async (useUserBudgetFallback = false) => {
    if (!instruction.trim() || !workspaceId) return;

    onError(null);
    setPlanUsage(null);
    setPlanContextUsed(null);
    setRunScope(null);
    setPlanDebugInfo(null);
    setPlanHash?.(null);
    setAgentEvents([]);
    setRunSummary(null);
    setModelFallbackBanner(null);
    setPlanRetryBanner?.(null);
    onPhase("loading_plan");

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const fileList = await fetchFileList();
      const res = await fetch("/api/agent/plan-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(useUserBudgetFallback ? { "X-Budget-Fallback": "user-only" } : {}),
        },
        body: JSON.stringify({
          instruction: instruction.trim(),
          workspaceId,
          ...(previousPlan ? { previousPlan } : {}),
          ...(modelSelection.type === "model"
            ? { modelId: modelSelection.modelId }
            : modelSelection.type === "group"
              ? { modelGroupId: modelSelection.modelGroupId }
              : { provider, model: provider === "openrouter" ? model : undefined }),
          fileList,
          useIndex: true,
          scopeMode: scopeMode ?? "normal",
          mode: "reproducible", // Phase 4: deterministic planning (temp=0, stable prompt)
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: "Plan failed" }));
        // Soft fallback: workspace budget exceeded → auto-retry with user budget (no modal)
        if (res.status === 429 && errorData.canFallbackToUser && errorData.scope === "workspace" && !useUserBudgetFallback) {
          return startPlan(true);
        }
        // Hard stop: user budget exceeded (no alternative) → show modal
        if (res.status === 429 && errorData.code === "BUDGET_EXCEEDED" && errorData.scope === "user") {
          setBudgetExceededModal({ message: errorData.error || "Daily token budget exceeded. Try again tomorrow.", scope: "user" });
          onPhase("idle");
          return;
        }
        const retryAfter =
          errorData.retryAfter ??
          (parseInt(res.headers.get("Retry-After") || "0", 10) || undefined);
        onError(
          parseApiErrorForDisplay(
            errorData.error || "Plan failed",
            res.status,
            retryAfter
          )
        );
        onPhase("idle");
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("Stream unavailable. The server returned an empty response. Try again.");

      let buffer = "";
      let finalPlan: AgentPlan | null = null;
      let finalUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; inputTokens?: number; outputTokens?: number } | null = null;
      let finalModelFallback: { from: string; to: string; reason?: "rate_limit" | "capability" } | undefined;
      let finalPlanDebugInfo: PlanDebugInfo | null = null;
      let finalAvailableFreeModels: { id: string; label: string }[] | undefined;
      let lastStatusMessage: string | null = null;
      let lastErrorCode: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (value) lastActivityRef.current = Date.now();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "plan") {
                finalPlan = data.plan;
                if (typeof data.planHash === "string") setPlanHash?.(data.planHash);
                finalUsage = data.usage;
                finalPlanDebugInfo = {
                  modelUsed: data.modelUsed ?? "unknown",
                  tokensReserved: data.tokensReserved ?? 0,
                  tokensUsed: data.usage
                    ? {
                        input: data.usage.inputTokens ?? data.usage.prompt_tokens,
                        output: data.usage.outputTokens ?? data.usage.completion_tokens,
                        total: data.usage.total_tokens ?? (data.usage.inputTokens != null && data.usage.outputTokens != null ? data.usage.inputTokens + data.usage.outputTokens : undefined),
                      }
                    : null,
                  providerErrors: Array.isArray(data.providerErrors) ? data.providerErrors : [],
                  fallbackReason: data.modelFallback?.reason ?? null,
                  streamDurationMs: data.durationMs ?? 0,
                };
                if (data.modelFallback?.from && data.modelFallback?.to) {
                  finalModelFallback = {
                    from: data.modelFallback.from,
                    to: data.modelFallback.to,
                    reason: data.modelFallback.reason === "rate_limit" || data.modelFallback.reason === "capability" ? data.modelFallback.reason : undefined,
                  };
                }
                if (Array.isArray(data.availableFreeModels) && data.availableFreeModels.length > 0) {
                  finalAvailableFreeModels = data.availableFreeModels
                    .map((m: { id?: string; label?: string }) => ({ id: m?.id ?? "", label: m?.label ?? m?.id ?? "" }))
                    .filter((m: { id: string }) => m.id);
                }
                if (data.contextUsed?.filePaths) setPlanContextUsed(data.contextUsed.filePaths);
                if (data.scope?.fileCount != null) {
                  setRunScope({ fileCount: data.scope.fileCount, approxLinesChanged: data.scope.approxLinesChanged ?? 0 });
                }
              } else if (data.type === "plan_drift_warning") {
                setAgentEvents((prev) => [
                  ...prev,
                  {
                    id: `${Date.now()}`,
                    type: "status",
                    message: data.message ?? "The plan changed significantly. Enable deterministic mode for consistent results.",
                    createdAt: new Date().toISOString(),
                  },
                ]);
              } else if (data.type === "error") {
                lastStatusMessage = data.error || data.message || data.reason || "Unknown error";
                lastErrorCode = data.code ?? null;
                if (data.code === "ALL_MODELS_EXHAUSTED" && data.recommendedProviders && data.recommendedModels) {
                  setModelsExhaustedModal?.({
                    recommendedProviders: data.recommendedProviders,
                    recommendedModels: data.recommendedModels,
                  });
                }
                setAgentEvents((prev) => [
                  ...prev,
                  {
                    id: `${Date.now()}`,
                    type: "status",
                    message: lastStatusMessage ?? "Unknown error",
                    createdAt: new Date().toISOString(),
                  },
                ]);
              } else if (data.id && data.type && data.message) {
                const event = data as AgentEvent;
                if (event.type === "status" && typeof event.message === "string" && (event.message.startsWith("Error:") || event.message.includes("valid") || event.message.includes("JSON"))) {
                  lastStatusMessage = event.message;
                }
                if (event.type === "status" && typeof event.message === "string") {
                  const msg = event.message;
                  if (
                    msg.includes("Planner retrying") ||
                    msg.includes("Plan layout violation") ||
                    msg.includes("Retrying with corrective hint") ||
                    msg.includes("Trying fallback provider") ||
                    msg.includes("Layout corrective retry")
                  ) {
                    setPlanRetryBanner?.({ message: msg });
                  }
                }
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
                  if (event.type === "status" && event.meta?.scope?.fileCount != null) {
                    summary.scope = { fileCount: event.meta.scope.fileCount, approxLinesChanged: event.meta.scope.approxLinesChanged ?? 0 };
                  }
                  if (event.type === "status" && event.meta?.scopeMode) summary.scopeMode = event.meta.scopeMode as ScopeMode;
                  if (event.type === "status" && event.meta?.retried !== undefined) summary.retried = event.meta.retried;
                  if (event.type === "status" && event.meta?.retryReason) summary.retryReason = event.meta.retryReason;
                  if (event.type === "status" && event.meta?.attempt1) summary.attempt1 = event.meta.attempt1;
                  if (event.type === "status" && event.meta?.attempt2) summary.attempt2 = event.meta.attempt2;
                  if (event.type === "tool_result" && event.meta?.filePath) summary.editedFiles.add(event.meta.filePath);
                  if (event.type === "tool_call" && event.meta?.command && !summary.commandsRun.includes(event.meta.command)) {
                    summary.commandsRun.push(event.meta.command);
                  }
                  return { ...summary };
                });
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      if (finalPlan?.steps?.length) {
        const validSteps: PlanStep[] = [];
        finalPlan.steps.forEach((step: PlanStep) => {
          if (!step || typeof step !== "object") return;
          if (step.type === "file_edit") {
            if (!step.path || typeof step.newContent !== "string") return;
            validSteps.push(step as FileEditStep);
          } else if (step.type === "command") {
            if (!step.command || typeof step.command !== "string") return;
            validSteps.push(step as CommandStep);
          }
        });

        if (validSteps.length === 0) {
          const fullPlanPreview = JSON.stringify(finalPlan, null, 2).slice(0, 800);
          throw new Error(`Plan has no valid steps. All ${finalPlan.steps.length} step(s) are missing required fields.\n\nFull plan preview:\n${fullPlanPreview}`);
        }

        const validatedPlan: AgentPlan = { ...finalPlan, steps: validSteps };
        onPlan(validatedPlan);
        if (finalModelFallback) {
          setModelFallbackBanner({
            from: finalModelFallback.from,
            to: finalModelFallback.to,
            reason: finalModelFallback.reason,
            availableFreeModels: finalAvailableFreeModels ?? [],
          });
        } else {
          setModelFallbackBanner(null);
        }
        setPlanRetryBanner?.(null);
        if (finalPlanDebugInfo) setPlanDebugInfo(finalPlanDebugInfo);
        else setPlanDebugInfo(null);
        if (finalUsage) {
          const u = finalUsage;
          const parts: string[] = [];
          const total = u.total_tokens ?? (u.inputTokens != null && u.outputTokens != null ? u.inputTokens + u.outputTokens : null);
          if (total != null) parts.push(`Total: ${total.toLocaleString()} tokens`);
          if (u.inputTokens != null && u.outputTokens != null) {
            parts.push(`Input: ${u.inputTokens.toLocaleString()} | Output: ${u.outputTokens.toLocaleString()}`);
          } else {
            if (u.inputTokens != null) parts.push(`Input: ${u.inputTokens.toLocaleString()}`);
            if (u.outputTokens != null) parts.push(`Output: ${u.outputTokens.toLocaleString()}`);
          }
          if (provider === "openai" && u.inputTokens != null && u.outputTokens != null) {
            const inputCost = (u.inputTokens / 1_000_000) * 0.15;
            const outputCost = (u.outputTokens / 1_000_000) * 0.6;
            const totalCost = inputCost + outputCost;
            if (totalCost > 0.0001) parts.push(`Est. cost: $${totalCost.toFixed(4)}`);
          }
          if (parts.length > 0) setPlanUsage(parts.join(" • "));
        }
        onPhase("plan_ready");
      } else {
        if (finalPlan && (!finalPlan.steps || finalPlan.steps.length === 0)) {
          throw new Error("Empty plan returned: The agent couldn't generate any steps. Try being more explicit about what needs to be fixed.");
        }
        // Phase 5: Use actionable message for AGENT_PROTOCOL_FAILURE / INVALID_AGENT_PLAN
        if ((lastErrorCode === "AGENT_PROTOCOL_FAILURE" || lastErrorCode === "INVALID_AGENT_PLAN") && lastStatusMessage) {
          throw new Error(lastStatusMessage);
        }
        const detail = lastStatusMessage ?? "The stream may have closed prematurely or the provider failed. Try again or select a different provider.";
        // Surface budget/token limit errors directly instead of framing as "empty plan"
        const isBudgetError = /token limit|token budget|BUDGET_EXCEEDED|daily.*limit/i.test(detail);
        if (isBudgetError) {
          throw new Error(detail.replace(/^Error:\s*/i, "").trim());
        }
        throw new Error(`Empty plan returned: The agent didn't return a valid plan. ${detail}`);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (stuckTimeoutAbortRef.current) {
          stuckTimeoutAbortRef.current = false;
          onError("Request timed out. The model may have stalled. Try again.");
          onPhase("idle");
          return;
        }
        setAgentEvents((prev) => [
          ...prev,
          { id: `${Date.now()}`, type: "status", message: "Run cancelled by user", createdAt: new Date().toISOString() },
        ]);
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
        onPhase("idle");
        return;
      }
      const errorMsg = e instanceof Error ? e.message : "Plan failed";
      const isRetryable = /empty plan returned|no valid steps|returned no steps|maximum call stack size exceeded|missing required fields/i.test(errorMsg);

      const isNetworkError = /failed to fetch|network error|load failed|network request failed|connection refused|econnrefused|econnreset|socket hang up/i.test(errorMsg);
      if (isNetworkError) {
        if (process.env.NODE_ENV === "development") {
          console.error("[useAgentPlan] Network/connection error:", e);
        }
        const hint = typeof window !== "undefined" && window.location?.hostname === "localhost"
          ? ` Ensure the dev server is running (npm run dev).`
          : "";
        onError(`Connection lost. Check your network and try again.${hint}`);
      } else if (errorMsg.includes("No API key configured")) {
        if (errorMsg.includes("OpenRouter") || errorMsg.includes("openrouter")) {
          onError(`No API key configured. Get a free OpenRouter key at https://openrouter.ai/keys and add it in Settings → API Keys.`);
        } else {
          onError(`${errorMsg} Add an API key in Settings → API Keys. Recommended: OpenRouter (free models) or Gemini (free tier).`);
        }
      } else {
        let msg = errorMsg.includes(PROVIDER_LABELS[provider]) ? errorMsg : `${PROVIDER_LABELS[provider]}: ${errorMsg}`;
        if (errorMsg.toLowerCase().includes("not a valid model") || errorMsg.includes("invalid model")) {
          msg += " If you use an OpenAI key, switch the Provider dropdown above to \"OpenAI\".";
        }
        onError(msg);
      }
      onPhase("idle");

      if (isRetryable && autoRetryCountRef.current < 1) {
        autoRetryCountRef.current = 1;
        onAutoRetry(startPlan);
      }
    } finally {
      abortControllerRef.current = null;
    }
  }, [
    instruction,
    workspaceId,
    previousPlan,
    provider,
    model,
    modelSelection,
    scopeMode,
    fetchFileList,
    onPlan,
    setPlanHash,
    setModelsExhaustedModal,
    onPhase,
    onError,
    setAgentEvents,
    setRunSummary,
    setPlanContextUsed,
    setRunScope,
    setPlanUsage,
    setModelFallbackBanner,
    lastActivityRef,
    abortControllerRef,
    stuckTimeoutAbortRef,
    onAutoRetry,
  ]);

  const rejectPlan = useCallback(() => {
    onPlan(null);
    onPhase("idle");
    onError(null);
    setModelFallbackBanner(null);
    setPlanDebugInfo(null);
  }, [onPlan, onPhase, onError, setModelFallbackBanner, setPlanDebugInfo]);

  const onBudgetExceededContinue = useCallback(() => {
    setBudgetExceededModal(null);
    startPlan(true);
  }, [startPlan]);

  const onBudgetExceededDismiss = useCallback(() => {
    setBudgetExceededModal(null);
    onError("Workspace daily token limit exceeded. Try again tomorrow.");
    onPhase("idle");
  }, [onError, onPhase]);

  return {
    startPlan,
    rejectPlan,
    budgetExceededModal,
    onBudgetExceededContinue,
    onBudgetExceededDismiss,
  };
}
