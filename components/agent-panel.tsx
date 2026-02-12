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
import { Skeleton } from "@/components/ui/skeleton";
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
import { useAgentPlan } from "@/hooks/useAgentPlan";
import { useAgentExecute } from "@/hooks/useAgentExecute";
import { useUndoRedo } from "@/hooks/useUndoRedo";

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
  const { canUndo, canRedo, undo, redo, refetch: refetchUndoRedo } = useUndoRedo(workspaceId, updateContent);
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

  // Phase 7.3: Undo/Redo keyboard shortcuts (only when agent result visible and focus not in input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (phase !== "done" || !executeResult) return;
      const target = e.target as HTMLElement;
      if (target?.closest?.("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        if (e.shiftKey && canRedo) {
          e.preventDefault();
          redo();
        } else if (!e.shiftKey && canUndo) {
          e.preventDefault();
          undo();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [phase, executeResult, canUndo, canRedo, undo, redo]);

  const fetchFileList = useCallback(async (): Promise<string[]> => {
    if (!workspaceId) return [];
    const res = await fetch(`/api/workspaces/${workspaceId}/files`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map((f: { path: string }) => f.path) : [];
  }, [workspaceId]);

  const { startPlan: startPlanFromHook, rejectPlan: rejectPlanFromHook } = useAgentPlan({
    workspaceId,
    instruction,
    provider,
    model,
    modelSelection,
    scopeMode,
    fetchFileList,
    onPlan: setPlan,
    onPhase: setPhase,
    onError: setError,
    setAgentEvents,
    setRunSummary,
    setPlanContextUsed,
    setRunScope,
    setPlanUsage,
    setModelFallbackBanner,
    lastActivityRef,
    abortControllerRef,
    stuckTimeoutAbortRef,
    onAutoRetry: (startPlanFn) => {
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
        startPlanFn();
      }, delayMs);
    },
  });

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
    await startPlanFromHook();
  }, [instruction, workspaceId, phase, logAttachment, useDebugForLogs, startPlanFromHook]);

  const rejectPlan = rejectPlanFromHook;

  const { doExecute } = useAgentExecute({
    workspaceId,
    plan,
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
    openFile: (path, content) => openFile(path, content ?? ""),
  });

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

        {/* Plan skeleton when loading */}
        {phase === "loading_plan" && !plan && (
          <div className="flex flex-col rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/5" />
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
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            onEditsApplied={refetchUndoRedo}
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
