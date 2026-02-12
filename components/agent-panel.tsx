"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { Play, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/editor-context";
import { useTerminal } from "@/lib/terminal-context";
import { PROVIDERS, PROVIDER_LABELS, OPENROUTER_FREE_MODELS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan, PlanStep, FileEditStep, CommandStep, AgentExecuteResult, ScopeMode } from "@/lib/agent/types";
import { SAFE_EDIT_MAX_FILES } from "@/lib/protected-paths";
import type { AgentEvent } from "@/lib/agent-events";
import { openFileInWorkspace } from "@/lib/open-file-in-workspace";
import { useWorkspaceLabel } from "@/lib/use-workspace-label";
import { ModelsManagerDialog } from "@/components/models-manager-dialog";
import { getPlaybook } from "@/lib/playbooks";
import {
  AgentInstructionInput,
  AgentFooterActions,
  AgentErrorDisplay,
  AgentModelSelector,
  AgentPlanReview,
  AgentEventsLog,
  AgentExecutionResult,
  AgentConfirmDialogs,
  AgentReviewQueue,
} from "@/components/agent";
import type { LogAttachment } from "@/lib/chat/log-utils";

type AgentPhase = "idle" | "loading_plan" | "plan_ready" | "executing" | "done";

type ModelSelection =
  | { type: "auto" }
  | { type: "model"; modelId: string; label: string }
  | { type: "group"; modelGroupId: string; label: string };

interface AvailableModel {
  id: string;
  label: string;
  provider: string;
  modelSlug: string;
  isDefault?: boolean;
  isFree?: boolean;
  hasKey?: boolean | string;
}
interface AvailableGroup {
  id: string;
  label: string;
  description?: string;
}

type AgentPanelProps = {
  workspaceId: string | null;
};

export function AgentPanel({ workspaceId }: AgentPanelProps) {
  const { getTab, updateContent, openFile, setActiveTab } = useEditor();
  const { addLog } = useTerminal();
  const workspaceLabel = useWorkspaceLabel(workspaceId);
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<AgentPhase>("idle");
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [executeResult, setExecuteResult] = useState<AgentExecuteResult | null>(null);
  const [agentReviewAccepted, setAgentReviewAccepted] = useState<Set<string>>(new Set());
  const [agentReviewApplying, setAgentReviewApplying] = useState(false);
  /** Phase F: review each file in diff before apply (like Composer). Queue of { path, originalContent, newContent }. */
  const [agentReviewQueue, setAgentReviewQueue] = useState<{ path: string; originalContent: string; newContent: string }[]>([]);
  const [agentReviewIndex, setAgentReviewIndex] = useState(0);
  /** When apply-edits returns 400 (large edit blocked), offer "Apply anyway" with confirmLargeEdit. */
  const [agentLargeEditConfirmOpen, setAgentLargeEditConfirmOpen] = useState(false);
  const [pendingLargeEditEdits, setPendingLargeEditEdits] = useState<{ path: string; content: string }[]>([]);
  const [agentFullFileReplaceConfirmOpen, setAgentFullFileReplaceConfirmOpen] = useState(false);
  const [pendingFullFileReplaceEdits, setPendingFullFileReplaceEdits] = useState<{ path: string; content: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoRetryIn, setAutoRetryIn] = useState<number | null>(null); // seconds until auto-retry, null when not scheduled
  const autoRetryCountRef = useRef(0);
  const autoRetryTimeoutRef = useRef<number | NodeJS.Timeout | null>(null);
  const autoRetryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [logAttachment, setLogAttachment] = useState<LogAttachment | null>(null);
  const [useDebugForLogs] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("useDebugForLogs") !== "false";
  });

  // Load provider and model from localStorage, default to openrouter + deepseek-coder:free
  const getStoredProvider = (): ProviderId => {
    if (typeof window === "undefined") return "openrouter";
    const key = workspaceId ? `agent-provider-${workspaceId}` : "agent-provider-default";
    const stored = localStorage.getItem(key);
    return (stored && PROVIDERS.includes(stored as ProviderId)) ? (stored as ProviderId) : "openrouter";
  };

  const getStoredModel = (): string => {
    if (typeof window === "undefined") return "openrouter/free";
    const key = workspaceId ? `agent-model-${workspaceId}` : "agent-model-default";
    const stored = localStorage.getItem(key);
    const m = stored || "openrouter/free";
    if (m === "deepseek/deepseek-coder:free" || m === "deepseek/deepseek-r1:free") return "openrouter/free";
    return m;
  };
  
  const [provider, setProviderState] = useState<ProviderId>(getStoredProvider());
  const [model, setModelState] = useState<string>(getStoredModel());
  const [planUsage, setPlanUsage] = useState<string | null>(null);
  const [runScope, setRunScope] = useState<{ fileCount: number; approxLinesChanged: number } | null>(null);
  const getStoredScopeMode = (): ScopeMode => {
    if (typeof window === "undefined") return "normal";
    const key = workspaceId ? `agent-scope-mode-${workspaceId}` : "agent-scope-mode-default";
    const stored = localStorage.getItem(key);
    return stored === "conservative" || stored === "aggressive" ? stored : "normal";
  };
  const [scopeMode, setScopeModeState] = useState<ScopeMode>(getStoredScopeMode());
  const [aggressiveConfirmOpen, setAggressiveConfirmOpen] = useState(false);
  const [planContextUsed, setPlanContextUsed] = useState<string[] | null>(null);
  const [largeFileConfirmOpen, setLargeFileConfirmOpen] = useState(false);
  const [largeFileCount, setLargeFileCount] = useState(0);
  const [protectedConfirmOpen, setProtectedConfirmOpen] = useState(false);
  const [protectedPathsList, setProtectedPathsList] = useState<string[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [runSummary, setRunSummary] = useState<{
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
  } | null>(null);
  const [modelFallbackBanner, setModelFallbackBanner] = useState<{
    from: string;
    to: string;
    availableFreeModels: { id: string; label: string }[];
  } | null>(null);
  const [modelsAvailable, setModelsAvailable] = useState<{
    defaultModels: AvailableModel[];
    userModels: (AvailableModel & { id?: string; modelId: string; enabled: boolean })[];
    groups: AvailableGroup[];
  } | null>(null);
  const [modelSelection, setModelSelectionState] = useState<ModelSelection>({ type: "auto" });
  const [modelsManagerOpen, setModelsManagerOpen] = useState(false);
  const [defaultGroupInfo, setDefaultGroupInfo] = useState<{
    groupId: string | null;
    isUserSaved: boolean;
    label?: string;
    members: { modelId: string; label: string; role: string }[];
  } | null>(null);
  const [defaultGroupSaving, setDefaultGroupSaving] = useState(false);
  const [rulesFile, setRulesFile] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** Stuck detection: if no stream progress for this long, auto-abort so user isn't left hanging. */
  const STUCK_TIMEOUT_MS = 240_000; // 4 minutes
  const lastActivityRef = useRef<number>(0);
  const stuckTimeoutIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stuckTimeoutAbortRef = useRef(false);
  const eventsEndRef = useRef<HTMLDivElement | null>(null);
  const [showAgentFeedback, setShowAgentFeedback] = useState(false);

  useEffect(() => {
    if (phase !== "done") setShowAgentFeedback(false);
    else if (runSummary?.editedFiles?.size) setShowAgentFeedback(true);
  }, [phase, runSummary?.editedFiles?.size]);

  const modelSelectionStorageKey = workspaceId ? `agent-model-selection-${workspaceId}` : "agent-model-selection-default";
  const setModelSelection = useCallback(
    (sel: ModelSelection) => {
      setModelSelectionState(sel);
      if (typeof window !== "undefined") {
        localStorage.setItem(modelSelectionStorageKey, JSON.stringify(sel));
      }
    },
    [modelSelectionStorageKey]
  );

  useEffect(() => {
    const key = workspaceId ? `agent-model-selection-${workspaceId}` : "agent-model-selection-default";
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as ModelSelection;
        if (parsed?.type === "model" && parsed.modelId && parsed.label) setModelSelectionState(parsed);
        else if (parsed?.type === "group" && parsed.modelGroupId && parsed.label) setModelSelectionState(parsed);
      }
    } catch {
      // ignore
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setRulesFile(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/rules-info`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.rulesFile != null) setRulesFile(data.rulesFile);
        else if (!cancelled) setRulesFile(null);
      })
      .catch(() => { if (!cancelled) setRulesFile(null); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models/available")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setModelsAvailable(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelsManagerOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models/default-group")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.members) setDefaultGroupInfo(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelsManagerOpen, modelSelection.type]);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [agentEvents]);

  // Persist provider selection (used by provider selector when wired)
  const _setProvider = useCallback((newProvider: ProviderId) => {
    setProviderState(newProvider);
    if (typeof window !== "undefined") {
      const key = workspaceId ? `agent-provider-${workspaceId}` : "agent-provider-default";
      localStorage.setItem(key, newProvider);
      // Reset model to default if switching away from OpenRouter
      if (newProvider !== "openrouter") {
        const modelKey = workspaceId ? `agent-model-${workspaceId}` : "agent-model-default";
        localStorage.removeItem(modelKey);
        setModelState("");
      } else if (!model || !OPENROUTER_FREE_MODELS.some(m => m.id === model)) {
        setModelState("openrouter/free");
      }
    }
  }, [workspaceId, model]);

  // Persist model selection (used by model selector when wired)
  const _setModel = useCallback((newModel: string) => {
    setModelState(newModel);
    if (typeof window !== "undefined") {
      const key = workspaceId ? `agent-model-${workspaceId}` : "agent-model-default";
      localStorage.setItem(key, newModel);
    }
  }, [workspaceId]);

  // Update provider/model/scopeMode when workspace changes
  useEffect(() => {
    setProviderState(getStoredProvider());
    setModelState(getStoredModel());
    setScopeModeState(getStoredScopeMode());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when workspace changes
  }, [workspaceId]);

  const setScopeMode = useCallback((mode: ScopeMode) => {
    setScopeModeState(mode);
    if (typeof window !== "undefined") {
      const key = workspaceId ? `agent-scope-mode-${workspaceId}` : "agent-scope-mode-default";
      localStorage.setItem(key, mode);
    }
  }, [workspaceId]);

  // First-run / playbook: apply pending playbook instruction when Agent mounts with a workspace
  useEffect(() => {
    if (!workspaceId || typeof sessionStorage === "undefined") return;
    try {
      const pending = sessionStorage.getItem("pendingPlaybookId");
      if (!pending) return;
      const playbook = getPlaybook(pending);
      sessionStorage.removeItem("pendingPlaybookId");
      if (playbook?.instruction) setInstruction(playbook.instruction);
    } catch {}
  }, [workspaceId]);

  // Reset auto-retry count when user changes instruction or workspace (new run gets one retry)
  useEffect(() => {
    autoRetryCountRef.current = 0;
  }, [instruction, workspaceId]);

  // Clear pending auto-retry on unmount or when instruction/workspace changes
  useEffect(() => {
    return () => {
      if (autoRetryIntervalRef.current != null) {
        clearInterval(autoRetryIntervalRef.current);
        autoRetryIntervalRef.current = null;
      }
      if (autoRetryTimeoutRef.current != null) {
        clearTimeout(autoRetryTimeoutRef.current);
        autoRetryTimeoutRef.current = null;
      }
      setAutoRetryIn(null);
    };
  }, [instruction, workspaceId]);

  // Stuck-timeout: if no stream progress for 2 min while planning/executing, auto-abort so user isn't left hanging
  useEffect(() => {
    if (phase !== "loading_plan" && phase !== "executing") {
      if (stuckTimeoutIntervalRef.current) {
        clearInterval(stuckTimeoutIntervalRef.current);
        stuckTimeoutIntervalRef.current = null;
      }
      stuckTimeoutAbortRef.current = false;
      return;
    }
    lastActivityRef.current = Date.now();
    const checkMs = 15_000;
    stuckTimeoutIntervalRef.current = setInterval(() => {
      if (Date.now() - lastActivityRef.current > STUCK_TIMEOUT_MS && abortControllerRef.current) {
        stuckTimeoutAbortRef.current = true;
        abortControllerRef.current.abort();
      }
    }, checkMs);
    return () => {
      if (stuckTimeoutIntervalRef.current) {
        clearInterval(stuckTimeoutIntervalRef.current);
        stuckTimeoutIntervalRef.current = null;
      }
    };
  }, [phase]);

  const fetchFileList = useCallback(async (): Promise<string[]> => {
    if (!workspaceId) return [];
    const res = await fetch(`/api/workspaces/${workspaceId}/files`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map((f: { path: string }) => f.path) : [];
  }, [workspaceId]);

  const startPlan = useCallback(async () => {
    const hasLog = !!logAttachment;
    const canStart = instruction.trim() || hasLog;
    if (!canStart || !workspaceId || phase !== "idle") return;

    if (hasLog && useDebugForLogs && logAttachment) {
      try {
        sessionStorage.setItem(
          "pendingDebugLog",
          JSON.stringify({
            logText: logAttachment.fullText,
            userMessageContent: instruction.trim() || "Debug this error log.",
            logAttachment,
          })
        );
        window.dispatchEvent(new CustomEvent("code-compass-run-debug-from-log"));
        setInstruction("");
        setLogAttachment(null);
      } catch {
        setError("Failed to start debug");
      }
      return;
    }

    if (!instruction.trim()) return;
    setError(null);
    setPlanUsage(null);
    setPlanContextUsed(null);
    setRunScope(null);
    setAgentEvents([]);
    setRunSummary(null);
    setModelFallbackBanner(null);
    setPhase("loading_plan");
    
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    try {
      const fileList = await fetchFileList();
      const res = await fetch("/api/agent/plan-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: instruction.trim(),
          workspaceId,
          ...(modelSelection.type === "model"
            ? { modelId: modelSelection.modelId }
            : modelSelection.type === "group"
              ? { modelGroupId: modelSelection.modelGroupId }
              : { provider, model: provider === "openrouter" ? model : undefined }),
          fileList,
          useIndex: true,
          scopeMode: scopeMode ?? "normal",
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: "Plan failed" }));
        throw new Error(errorData.error || "Plan failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response body");

      let buffer = "";
      let finalPlan: AgentPlan | null = null;
      let finalUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
      let finalModelFallback: { from: string; to: string } | undefined;
      let finalAvailableFreeModels: { id: string; label: string }[] | undefined;
      let lastStatusMessage: string | null = null;

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
                finalUsage = data.usage;
                if (data.modelFallback && typeof data.modelFallback === "object" && data.modelFallback.from && data.modelFallback.to) {
                  finalModelFallback = { from: data.modelFallback.from, to: data.modelFallback.to };
                }
                if (Array.isArray(data.availableFreeModels) && data.availableFreeModels.length > 0) {
                  finalAvailableFreeModels = data.availableFreeModels.map((m: { id?: string; label?: string }) => ({ id: m?.id ?? "", label: m?.label ?? m?.id ?? "" })).filter((m: { id: string }) => m.id);
                }
                if (data.contextUsed && Array.isArray(data.contextUsed.filePaths)) {
                  setPlanContextUsed(data.contextUsed.filePaths);
                }
                if (data.scope && typeof data.scope.fileCount === "number") {
                  setRunScope({ fileCount: data.scope.fileCount, approxLinesChanged: data.scope.approxLinesChanged ?? 0 });
                }
              } else if (data.type === "error") {
                // Handle error events from the stream
                lastStatusMessage = data.error || data.message || "Unknown error";
                setAgentEvents((prev) => [...prev, {
                  id: `${Date.now()}`,
                  type: "status",
                  message: lastStatusMessage ?? "Unknown error",
                  createdAt: new Date().toISOString(),
                }]);
              } else if (data.id && data.type && data.message) {
                const event = data as AgentEvent;
                if (event.type === "status" && typeof event.message === "string" && (event.message.startsWith("Error:") || event.message.includes("valid") || event.message.includes("JSON"))) {
                  lastStatusMessage = event.message;
                }
                setAgentEvents((prev) => [...prev, event]);
                
                // Update run summary aggregates
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
                  
                  // Count by type
                  if (event.type === "reasoning") summary.reasoningCount++;
                  else if (event.type === "tool_call") summary.toolCallCount++;
                  else if (event.type === "tool_result") summary.toolResultCount++;
                  else if (event.type === "status") summary.statusCount++;
                  
                  // Scope/scopeMode from status events
                  if (event.type === "status" && event.meta?.scope && typeof event.meta.scope.fileCount === "number") {
                    summary.scope = { fileCount: event.meta.scope.fileCount, approxLinesChanged: event.meta.scope.approxLinesChanged ?? 0 };
                  }
                  if (event.type === "status" && event.meta?.scopeMode) summary.scopeMode = event.meta.scopeMode as ScopeMode;
                  if (event.type === "status" && event.meta?.retried !== undefined) summary.retried = event.meta.retried;
                  if (event.type === "status" && event.meta?.retryReason) summary.retryReason = event.meta.retryReason;
                  if (event.type === "status" && event.meta?.attempt1) summary.attempt1 = event.meta.attempt1;
                  if (event.type === "status" && event.meta?.attempt2) summary.attempt2 = event.meta.attempt2;
                  
                  // Track edited files (from tool_result events with filePath)
                  if (event.type === "tool_result" && event.meta?.filePath) {
                    summary.editedFiles.add(event.meta.filePath);
                  }
                  
                  // Track commands (from tool_call events with command)
                  if (event.type === "tool_call" && event.meta?.command) {
                    if (!summary.commandsRun.includes(event.meta.command)) {
                      summary.commandsRun.push(event.meta.command);
                    }
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

      // Validate plan structure before setting it
      if (finalPlan && finalPlan.steps && Array.isArray(finalPlan.steps) && finalPlan.steps.length > 0) {
        // Validate that steps have required fields
        const validSteps: PlanStep[] = [];
        const invalidSteps: Array<{ index: number; step: PlanStep; reason: string }> = [];
        
        finalPlan.steps.forEach((step: PlanStep, index: number) => {
          if (!step || typeof step !== "object") {
            invalidSteps.push({ index, step, reason: "Step is not an object" });
            return;
          }
          
          if (step.type === "file_edit") {
            if (!step.path || typeof step.path !== "string" || step.path.trim() === "") {
              invalidSteps.push({ index, step, reason: `Missing or empty 'path' field. Step has: ${JSON.stringify(Object.keys(step))}` });
              return;
            }
            if (!step.newContent || typeof step.newContent !== "string") {
              invalidSteps.push({ index, step, reason: `Missing or invalid 'newContent' field` });
              return;
            }
            validSteps.push(step as FileEditStep);
          } else if (step.type === "command") {
            if (!step.command || typeof step.command !== "string" || step.command.trim() === "") {
              invalidSteps.push({ index, step, reason: `Missing or empty 'command' field. Step has: ${JSON.stringify(Object.keys(step))}` });
              return;
            }
            validSteps.push(step as CommandStep);
          } else {
            const stepType = (step as { type?: string }).type;
            invalidSteps.push({ index, step, reason: `Unknown step type: ${stepType || "undefined"}` });
          }
        });
        
        if (validSteps.length === 0) {
          const errorDetails = invalidSteps.length > 0
            ? `\n\nInvalid steps details:\n${invalidSteps.map(({ index, reason, step }) => 
                `  Step ${index + 1}: ${reason}\n    Step keys: [${step && typeof step === "object" ? Object.keys(step).join(", ") : "N/A"}]\n    Step data: ${JSON.stringify(step, null, 2).slice(0, 400)}`
              ).join("\n\n")}`
            : "";
          const fullPlanPreview = JSON.stringify(finalPlan, null, 2).slice(0, 800);
          throw new Error(`Plan has no valid steps. All ${finalPlan.steps.length} step(s) are missing required fields.${errorDetails}\n\nFull plan preview:\n${fullPlanPreview}`);
        }
        
        // Log invalid steps but continue with valid ones
        if (invalidSteps.length > 0) {
          console.warn(`Plan has ${invalidSteps.length} invalid step(s) out of ${finalPlan.steps.length} total:`, invalidSteps);
        }
        
        // Use validated steps
        const validatedPlan: AgentPlan = {
          ...finalPlan,
          steps: validSteps,
        };
        
        setPlan(validatedPlan);
        if (finalModelFallback) {
          setModelFallbackBanner({
            from: finalModelFallback.from,
            to: finalModelFallback.to,
            availableFreeModels: finalAvailableFreeModels ?? [],
          });
        } else {
          setModelFallbackBanner(null);
        }
        if (finalUsage) {
          const u = finalUsage as {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          };
          const parts: string[] = [];
          if (u.totalTokens != null) {
            parts.push(`Total: ${u.totalTokens.toLocaleString()} tokens`);
          }
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
            if (totalCost > 0.0001) {
              parts.push(`Est. cost: $${totalCost.toFixed(4)}`);
            }
          }
          if (parts.length > 0) {
            setPlanUsage(parts.join(" • "));
          }
        }
        setPhase("plan_ready");
      } else {
        if (finalPlan && (!finalPlan.steps || finalPlan.steps.length === 0)) {
          throw new Error("Empty plan returned: The agent couldn't generate any steps. Try:\n- Including specific file paths in your error description\n- Being more explicit about what needs to be fixed\n- Checking if the files mentioned in errors exist in the workspace");
        }
        const detail = lastStatusMessage ?? "Check the activity feed above for details.";
        throw new Error(`Empty plan returned: The agent didn't return a valid plan. ${detail}`);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (stuckTimeoutAbortRef.current) {
          stuckTimeoutAbortRef.current = false;
          setError("Request timed out. The model may have stalled. Try again.");
          setPhase("idle");
          return;
        }
        const cancelEvent: AgentEvent = {
          id: `${Date.now()}`,
          type: "status",
          message: "Run cancelled by user",
          createdAt: new Date().toISOString(),
        };
        setAgentEvents((prev) => [...prev, cancelEvent]);
        setRunSummary((prev) => prev ? { ...prev, isComplete: true, wasCancelled: true } : {
          editedFiles: new Set<string>(),
          filesSkippedDueToConflict: new Set<string>(),
          commandsRun: [],
          reasoningCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          statusCount: 1,
          isComplete: true,
          wasCancelled: true,
        });
        setPhase("idle");
        return;
      }
      const errorMsg = e instanceof Error ? e.message : "Plan failed";
      const isRetryable =
        /empty plan returned|no valid steps|returned no steps|maximum call stack size exceeded|missing required fields/i.test(errorMsg);

      if (/failed to fetch|network error|load failed|network request failed/i.test(errorMsg)) {
        setError("Connection lost. Check your network and try again.");
      } else if (errorMsg.includes("No API key configured")) {
        // Enhanced error message with helpful links
        if (errorMsg.includes("OpenRouter") || errorMsg.includes("openrouter")) {
          setError(`No API key configured. Get a free OpenRouter key at https://openrouter.ai/keys and add it in Settings → API Keys.`);
        } else if (errorMsg.includes("Recommended")) {
          // Use the improved error message from backend
          setError(errorMsg);
        } else {
          setError(`${errorMsg} Add an API key in Settings → API Keys. Recommended: OpenRouter (free models) or Gemini (free tier).`);
        }
      } else {
        let msg = errorMsg.includes(PROVIDER_LABELS[provider]) ? errorMsg : `${PROVIDER_LABELS[provider]}: ${errorMsg}`;
        if (errorMsg.toLowerCase().includes("not a valid model") || errorMsg.includes("invalid model")) {
          msg += " If you use an OpenAI key, switch the Provider dropdown above to \"OpenAI\".";
        }
        setError(msg);
      }
      setPhase("idle");

      // Auto-retry once for model/plan failures (empty plan, stack overflow, etc.)
      if (isRetryable && autoRetryCountRef.current < 1) {
        autoRetryCountRef.current = 1;
        const delayMs = 3000;
        let remaining = Math.ceil(delayMs / 1000);
        setAutoRetryIn(remaining);
        const intervalId = setInterval(() => {
          remaining -= 1;
          setAutoRetryIn((r) => (r != null && r > 0 ? r - 1 : null));
        }, 1000);
        autoRetryIntervalRef.current = intervalId;
        autoRetryTimeoutRef.current = window.setTimeout(() => {
          if (autoRetryIntervalRef.current) {
            clearInterval(autoRetryIntervalRef.current);
            autoRetryIntervalRef.current = null;
          }
          autoRetryTimeoutRef.current = null;
          setAutoRetryIn(null);
          setError(null);
          startPlan();
        }, delayMs);
      }
    } finally {
      abortControllerRef.current = null;
    }
  }, [instruction, workspaceId, provider, model, modelSelection, phase, fetchFileList, logAttachment, useDebugForLogs]);

  const rejectPlan = useCallback(() => {
    setPlan(null);
    setPhase("idle");
    setError(null);
    setModelFallbackBanner(null);
  }, []);

  const doExecute = useCallback(
    async (confirmedProtectedPaths?: string[], skipProtected?: boolean, confirmedAggressive?: boolean) => {
      if (!plan || !workspaceId) return;
      setError(null);
      setAgentEvents([]);
      setRunSummary(null); // Reset summary for new execution
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
          throw new Error(errorData.error || "Execute failed");
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error("No response body");

        let buffer = "";
        let finalResult: AgentExecuteResult | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            lastActivityRef.current = Date.now();
            buffer += decoder.decode(value, { stream: true });
          }
          
          // Process complete lines (ending with \n)
          const lines = buffer.split("\n");
          // Keep the last incomplete line in buffer
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
                  // AgentEvent - track for summary
                  const event = data as AgentEvent;
                  setAgentEvents((prev) => [...prev, event]);
                  
                  // Update run summary aggregates
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
                    
                    // Count by type
                    if (event.type === "reasoning") summary.reasoningCount++;
                    else if (event.type === "tool_call") summary.toolCallCount++;
                    else if (event.type === "tool_result") summary.toolResultCount++;
                    else if (event.type === "status") summary.statusCount++;
                    
                    // Track edited files vs skipped (conflict) from tool_result with filePath
                    if (event.type === "tool_result" && event.meta?.filePath) {
                      if (event.meta.conflict) {
                        summary.filesSkippedDueToConflict.add(event.meta.filePath);
                      } else {
                        summary.editedFiles.add(event.meta.filePath);
                      }
                    }
                    
                    // Track commands (from tool_call events with command)
                    if (event.type === "tool_call" && event.meta?.command) {
                      if (!summary.commandsRun.includes(event.meta.command)) {
                        summary.commandsRun.push(event.meta.command);
                      }
                    }
                    
                    // Scope/scopeMode/retry from status events
                    if (event.type === "status" && event.meta?.scope && typeof event.meta.scope.fileCount === "number") {
                      summary.scope = { fileCount: event.meta.scope.fileCount, approxLinesChanged: event.meta.scope.approxLinesChanged ?? 0 };
                    }
                    if (event.type === "status" && event.meta?.scopeMode) summary.scopeMode = event.meta.scopeMode as ScopeMode;
                    if (event.type === "status" && event.meta?.retried !== undefined) summary.retried = event.meta.retried;
                    if (event.type === "status" && event.meta?.retryReason) summary.retryReason = event.meta.retryReason;
                    if (event.type === "status" && event.meta?.attempt1) summary.attempt1 = event.meta.attempt1;
                    if (event.type === "status" && event.meta?.attempt2) summary.attempt2 = event.meta.attempt2;
                    
                    // Check for completion status
                    if (event.type === "status" && (
                      event.message.toLowerCase().includes("complete") ||
                      event.message.toLowerCase().includes("finished") ||
                      event.message.toLowerCase().includes("done")
                    )) {
                      summary.isComplete = true;
                    }
                    
                    return { ...summary };
                  });
                }
              } catch (e) {
                // Skip invalid JSON - log for debugging
                console.warn("Failed to parse SSE line:", line.slice(0, 100), e);
              }
            }
          }
          
          if (done) {
            // Process any remaining buffer when stream ends
            if (buffer.trim() && buffer.startsWith("data: ")) {
              try {
                const jsonStr = buffer.slice(6).trim();
                if (jsonStr) {
                  const data = JSON.parse(jsonStr);
                  if (data.type === "result") {
                    finalResult = data.result;
                  } else if (data.id && data.type && data.message) {
                    const event = data as AgentEvent;
                    setAgentEvents((prev) => [...prev, event]);
                    
                    // Update summary for final event
                    setRunSummary((prev) => {
                      if (!prev) return null;
                      const summary = { ...prev };
                      if (event.type === "reasoning") summary.reasoningCount++;
                      else if (event.type === "tool_call") summary.toolCallCount++;
                      else if (event.type === "tool_result") {
                        summary.toolResultCount++;
                        if (event.meta?.filePath) {
                          if (event.meta.conflict) summary.filesSkippedDueToConflict.add(event.meta.filePath);
                          else summary.editedFiles.add(event.meta.filePath);
                        }
                      }
                      else if (event.type === "status") summary.statusCount++;
                      return summary;
                    });
                  }
                }
              } catch (e) {
                console.warn("Failed to parse final buffer:", buffer.slice(0, 200), e);
              }
            }
            break;
          }
        }

        if (!finalResult) {
          // Log what we received for debugging
          console.error("No result received. Events:", agentEvents.length, "Last events:", agentEvents.slice(-3));
          console.error("Remaining buffer:", buffer.slice(0, 500));
          throw new Error("No result received from execution stream. Check console for details.");
        }

        setExecuteResult(finalResult);
        const pr = (finalResult as { pendingReview?: { fileEdits: { path: string }[] } }).pendingReview;
        if (pr?.fileEdits?.length) {
          setAgentReviewAccepted(new Set(pr.fileEdits.map((e) => e.path)));
        }
        
        // Mark execution as complete; merge filesSkippedDueToConflict from result if present
        const skippedFromResult = (finalResult as { filesSkippedDueToConflict?: string[] }).filesSkippedDueToConflict;
        setRunSummary((prev) => {
          if (!prev) return null;
          const next = { ...prev, isComplete: true };
          if (Array.isArray(skippedFromResult) && skippedFromResult.length > 0) {
            next.filesSkippedDueToConflict = new Set([...prev.filesSkippedDueToConflict, ...skippedFromResult]);
          }
          return next;
        });

        // Log to terminal
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

        // Update files
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
          setRunSummary((prev) => prev ? { ...prev, isComplete: true, wasCancelled: true } : {
            editedFiles: new Set<string>(),
            filesSkippedDueToConflict: new Set<string>(),
            commandsRun: [],
            reasoningCount: 0,
            toolCallCount: 0,
            toolResultCount: 0,
            statusCount: 1,
            isComplete: true,
            wasCancelled: true,
          });
          setPhase("plan_ready");
          return;
        }
        const errMsg = e instanceof Error ? e.message : "Execute failed";
        if (/failed to fetch|network error|load failed|network request failed/i.test(errMsg)) {
          setError("Connection lost during run. Check your network and try again.");
        } else {
          setError(errMsg);
        }
        setPhase("plan_ready");
      } finally {
        abortControllerRef.current = null;
      }
    },
    [plan, workspaceId, provider, model, modelSelection, getTab, updateContent, openFile, addLog]
  );

  const approveAndExecute = useCallback(async () => {
    if (!plan || !workspaceId || phase !== "plan_ready") return;
    
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      setError("Invalid workspace ID");
      return;
    }
    
    const fileEditCount = plan.steps.filter((s) => s.type === "file_edit").length;
    
    // Try to fetch workspace for safe_edit_mode check, but don't fail if it doesn't work
    // The backend will validate the workspace exists during execution
    let safeEditMode = true; // Default to safe mode
    try {
      const wsRes = await fetch(`/api/workspaces/${workspaceId}`);
      if (wsRes.ok) {
        const ws = await wsRes.json();
        if (ws && ws.id) {
          safeEditMode = ws.safe_edit_mode !== false;
        }
      } else {
        // Workspace fetch failed - log but continue (backend will validate)
        console.warn("Could not fetch workspace for safe_edit_mode check, using default (true)");
      }
    } catch (e) {
      // Workspace fetch failed - log but continue
      console.warn("Workspace fetch error, using default safe_edit_mode:", e);
    }
    
    // Check file count threshold
    if (safeEditMode && fileEditCount > SAFE_EDIT_MAX_FILES) {
      setLargeFileCount(fileEditCount);
      setLargeFileConfirmOpen(true);
      return;
    }
    
    // Proceed with execution - backend will validate workspace exists
    await doExecute();
  }, [plan, workspaceId, phase, doExecute]);

  const confirmLargeFileExecute = useCallback(() => {
    setLargeFileConfirmOpen(false);
    doExecute();
  }, [doExecute]);

  const confirmProtectedExecute = useCallback(() => {
    setProtectedConfirmOpen(false);
    doExecute(protectedPathsList, false);
    setProtectedPathsList([]);
  }, [protectedPathsList, doExecute]);

  const cancelProtectedExecute = useCallback(() => {
    setProtectedConfirmOpen(false);
    setProtectedPathsList([]);
    doExecute([], true);
  }, [protectedPathsList, doExecute]);

  const cancelRun = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setPlan(null);
    setExecuteResult(null);
    setAgentReviewAccepted(new Set());
    setAgentReviewApplying(false);
    setPhase("idle");
    setError(null);
    setAgentEvents([]);
    setRunSummary(null);
  }, []);

  const rerunRequestedRef = useRef(false);
  const rerun = useCallback(() => {
    if (!instruction.trim() || !workspaceId) return;
    rerunRequestedRef.current = true;
    reset();
  }, [instruction, workspaceId, reset]);

  useEffect(() => {
    if (phase === "idle" && rerunRequestedRef.current && instruction.trim() && workspaceId) {
      rerunRequestedRef.current = false;
      startPlan();
    }
  }, [phase, instruction, workspaceId, startPlan]);

  const handleFileClick = useCallback(
    async (filePath: string, preferDiff = true) => {
      if (!workspaceId) return;
      await openFileInWorkspace({
        path: filePath,
        preferDiff,
        workspaceId,
        openFile,
        getTab,
        updateContent,
        setActiveTab,
      });
    },
    [workspaceId, openFile, getTab, updateContent, setActiveTab]
  );

  if (!workspaceId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-sm text-muted-foreground">
        <p>Open a workspace to use the Agent</p>
      </div>
    );
  }

  const hasErrors = executeResult?.log?.some((e) => e.status === "error");
  const statusPillLabel =
    phase === "loading_plan"
      ? "Planning"
      : phase === "plan_ready"
        ? "Plan ready"
        : phase === "executing"
          ? "Running plan…"
          : phase === "done"
            ? hasErrors
              ? "Failed"
              : "Completed"
            : "Idle";

  const workspaceLabelText = workspaceLabel
    ? `Workspace: ${workspaceLabel.name}${workspaceLabel.branch ? ` (${workspaceLabel.branch})` : ""}`
    : "Workspace: …";

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5 min-w-0">
        <p className="text-xs font-medium text-muted-foreground truncate" title={workspaceLabelText}>
          {workspaceLabelText}
        </p>
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              phase === "loading_plan" || phase === "executing"
                ? "bg-primary/15 text-primary"
                : phase === "done"
                  ? hasErrors
                    ? "bg-destructive/15 text-destructive"
                    : "bg-green-500/15 text-green-700 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {statusPillLabel}
          </span>
          {(phase === "loading_plan" || phase === "executing") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={cancelRun}
            >
              <XCircle className="h-3 w-3 mr-1" />
              Cancel
            </Button>
          )}
          {(phase === "done" || phase === "plan_ready") && instruction.trim() && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={rerun}
            >
              <Play className="h-3 w-3 mr-1" />
              Rerun
            </Button>
          )}
          {(phase === "done" || phase === "plan_ready") && plan && plan.steps?.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => doExecute()}
              disabled={false}
            >
              Re-run same plan
            </Button>
          )}
          <AgentModelSelector
            modelSelection={modelSelection}
            setModelSelection={setModelSelection}
            modelsAvailable={modelsAvailable}
            defaultGroupInfo={defaultGroupInfo}
            defaultGroupSaving={defaultGroupSaving}
            setDefaultGroupSaving={setDefaultGroupSaving}
            setDefaultGroupInfo={setDefaultGroupInfo}
            onModelsManagerOpen={() => setModelsManagerOpen(true)}
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-3">
        <p className="text-[11px] text-muted-foreground/90 flex items-center gap-1.5 flex-wrap">
          <span>Rules: {rulesFile ?? "No rules file"}</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("open-rules-editor"))}
            className="text-primary hover:underline text-[11px]"
          >
            Edit rules
          </button>
        </p>
        <AgentInstructionInput
          instruction={instruction}
          setInstruction={setInstruction}
          scopeMode={scopeMode}
          setScopeMode={setScopeMode}
          phase={phase}
          logAttachment={logAttachment}
          setLogAttachment={setLogAttachment}
          useDebugForLogs={useDebugForLogs}
          workspaceId={workspaceId}
          onStartPlan={startPlan}
        />

        {phase === "idle" && !plan && !instruction.trim() && (
          <p className="text-xs text-muted-foreground py-2">
            Describe a task and click Start. Paste error logs from the workspace to debug. Try <kbd className="rounded border border-border bg-muted/50 px-1 font-mono text-[10px]">Cmd+K</kbd> on a selection for quick edits.
          </p>
        )}

        <AgentErrorDisplay
          error={error}
          autoRetryIn={autoRetryIn}
          onRetry={() => {
            if (autoRetryTimeoutRef.current != null) {
              clearTimeout(autoRetryTimeoutRef.current);
              autoRetryTimeoutRef.current = null;
            }
            if (autoRetryIntervalRef.current != null) {
              clearInterval(autoRetryIntervalRef.current);
              autoRetryIntervalRef.current = null;
            }
            setAutoRetryIn(null);
            setError(null);
            if (phase === "plan_ready" && plan) {
              approveAndExecute();
            } else if (phase === "idle" && instruction.trim()) {
              startPlan();
            }
          }}
        />

        {/* Rate limit fallback banner */}
        {phase === "plan_ready" && modelFallbackBanner && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  Rate limit reached — switched model
                </p>
                <p className="text-muted-foreground">
                  Daily limit was reached on <span className="font-mono text-foreground/90">{modelFallbackBanner.from}</span>. We used <span className="font-mono text-foreground/90">{modelFallbackBanner.to}</span> instead.
                </p>
                {modelFallbackBanner.availableFreeModels.length > 0 && (
                  <p className="pt-1 text-muted-foreground">
                    Other free models you can try:{" "}
                    {modelFallbackBanner.availableFreeModels.map((m) => m.label || m.id).join(", ")}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setModelFallbackBanner(null)}
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* Plan review: constrained height so Approve/Reject stay visible */}
        {phase === "plan_ready" && plan && (
          <AgentPlanReview
            plan={plan}
            runScope={runScope}
            planUsage={planUsage}
            planContextUsed={planContextUsed}
            provider={provider}
          />
        )}

        {/* Agent Activity Feed - Shows real-time agent thinking and tool usage */}
        {(phase === "loading_plan" || phase === "executing" || (phase === "done" && agentEvents.length > 0) || (phase === "plan_ready" && runSummary?.wasCancelled)) && (
          <AgentEventsLog
            agentEvents={agentEvents}
            runSummary={runSummary}
            phase={phase}
            onFileClick={handleFileClick}
            eventsEndRef={eventsEndRef}
          />
        )}

        {/* Execution log + summary */}
        {phase === "done" && executeResult && (
          <AgentExecutionResult
            executeResult={executeResult}
            workspaceId={workspaceId}
            agentReviewAccepted={agentReviewAccepted}
            agentReviewApplying={agentReviewApplying}
            showAgentFeedback={showAgentFeedback}
            onOpenFile={(path, content) => openFile(path, content ?? "")}
            onUpdateContent={updateContent}
            onSetExecuteResult={setExecuteResult}
            onSetAgentReviewAccepted={setAgentReviewAccepted}
            onSetAgentReviewApplying={setAgentReviewApplying}
            onSetAgentReviewQueue={setAgentReviewQueue}
            onSetAgentReviewIndex={setAgentReviewIndex}
            onSetError={setError}
            onSetPendingFullFileReplaceEdits={setPendingFullFileReplaceEdits}
            onSetAgentFullFileReplaceConfirmOpen={setAgentFullFileReplaceConfirmOpen}
            onSetPendingLargeEditEdits={setPendingLargeEditEdits}
            onSetAgentLargeEditConfirmOpen={setAgentLargeEditConfirmOpen}
            onSetShowAgentFeedback={setShowAgentFeedback}
          />
        )}
      </div>

      <AgentFooterActions
        phase={phase}
        plan={plan}
        onApprove={approveAndExecute}
        onReject={rejectPlan}
        onRerun={rerun}
      />

      </div>

      <AgentConfirmDialogs
        largeFileConfirmOpen={largeFileConfirmOpen}
        largeFileCount={largeFileCount}
        onLargeFileClose={() => setLargeFileConfirmOpen(false)}
        onLargeFileConfirm={confirmLargeFileExecute}
        agentFullFileReplaceConfirmOpen={agentFullFileReplaceConfirmOpen}
        onFullFileReplaceClose={() => { setAgentFullFileReplaceConfirmOpen(false); setPendingFullFileReplaceEdits([]); }}
        onFullFileReplaceConfirm={async () => {
          if (!workspaceId || pendingFullFileReplaceEdits.length === 0) return;
          setAgentFullFileReplaceConfirmOpen(false);
          setAgentReviewApplying(true);
          try {
            const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ edits: pendingFullFileReplaceEdits, confirmFullFileReplace: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Failed to apply");
            for (const e of pendingFullFileReplaceEdits) updateContent(e.path, e.content);
            setExecuteResult((prev) => {
              if (!prev) return prev;
              const next = { ...prev, filesEdited: [...(prev.filesEdited ?? []), ...pendingFullFileReplaceEdits.map((x) => x.path)] };
              delete (next as Record<string, unknown>).pendingReview;
              return next;
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to apply");
          } finally {
            setAgentReviewApplying(false);
            setPendingFullFileReplaceEdits([]);
          }
        }}
        agentLargeEditConfirmOpen={agentLargeEditConfirmOpen}
        onLargeEditClose={() => { setAgentLargeEditConfirmOpen(false); setPendingLargeEditEdits([]); setAgentReviewApplying(false); }}
        onLargeEditConfirm={async () => {
          if (!workspaceId || pendingLargeEditEdits.length === 0) return;
          setAgentReviewApplying(true);
          try {
            const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ edits: pendingLargeEditEdits, confirmLargeEdit: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Failed to apply");
            for (const e of pendingLargeEditEdits) updateContent(e.path, e.content);
            setExecuteResult((prev) => {
              if (!prev) return prev;
              const next = { ...prev, filesEdited: [...(prev.filesEdited ?? []), ...pendingLargeEditEdits.map((x) => x.path)] };
              delete (next as Record<string, unknown>).pendingReview;
              return next;
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to apply");
          } finally {
            setAgentReviewApplying(false);
            setAgentLargeEditConfirmOpen(false);
            setPendingLargeEditEdits([]);
          }
        }}
        aggressiveConfirmOpen={aggressiveConfirmOpen}
        onAggressiveClose={() => setAggressiveConfirmOpen(false)}
        onAggressiveConfirm={() => { setAggressiveConfirmOpen(false); doExecute(undefined, undefined, true); }}
        protectedConfirmOpen={protectedConfirmOpen}
        protectedPathsList={protectedPathsList}
        onProtectedClose={() => { setProtectedConfirmOpen(false); setProtectedPathsList([]); }}
        onProtectedCancel={cancelProtectedExecute}
        onProtectedAllow={confirmProtectedExecute}
      />

      {/* Phase F: review each file in diff before apply (like Composer) */}
      <AgentReviewQueue
        queue={agentReviewQueue}
        index={agentReviewIndex}
        workspaceId={workspaceId}
        agentReviewAccepted={agentReviewAccepted}
        fileEdits={(executeResult?.pendingReview?.fileEdits ?? []) as { path: string; originalContent: string; newContent: string }[]}
        onSetAgentReviewAccepted={setAgentReviewAccepted}
        onSetAgentReviewQueue={setAgentReviewQueue}
        onSetAgentReviewIndex={setAgentReviewIndex}
        onSetAgentReviewApplying={setAgentReviewApplying}
        onSetExecuteResult={setExecuteResult}
        onUpdateContent={updateContent}
        onSetError={setError}
        onSetPendingFullFileReplaceEdits={setPendingFullFileReplaceEdits}
        onSetAgentFullFileReplaceConfirmOpen={setAgentFullFileReplaceConfirmOpen}
        onSetPendingLargeEditEdits={setPendingLargeEditEdits}
        onSetAgentLargeEditConfirmOpen={setAgentLargeEditConfirmOpen}
      />

      <ModelsManagerDialog
        open={modelsManagerOpen}
        onOpenChange={setModelsManagerOpen}
        modelsAvailable={modelsAvailable}
        onUpdated={() => {
          fetch("/api/models/available")
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => { if (data) setModelsAvailable(data); })
            .catch(() => {});
        }}
      />
    </div>
  );
}
