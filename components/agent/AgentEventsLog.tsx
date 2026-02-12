"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentEvent } from "@/lib/agent-events";
import type { ScopeMode } from "@/lib/agent/types";

type RunSummary = {
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
  attempt1?: { testsPassed?: boolean };
  attempt2?: { testsPassed?: boolean };
};

type AgentEventsLogProps = {
  agentEvents: AgentEvent[];
  runSummary: RunSummary | null;
  phase: "idle" | "loading_plan" | "plan_ready" | "executing" | "done";
  onFileClick: (path: string, preferDiff?: boolean) => void;
  eventsEndRef: React.RefObject<HTMLDivElement | null>;
};

export function AgentEventsLog({
  agentEvents,
  runSummary,
  phase,
  onFileClick,
  eventsEndRef,
}: AgentEventsLogProps) {
  useEffect(() => {
    if (eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [agentEvents, eventsEndRef]);

  const labelMap: Record<AgentEvent["type"], string> = {
    reasoning: "Thinking",
    tool_call: "Tool",
    tool_result: "Result",
    status: "Status",
    guardrail_warning: "Guardrail",
  };
  const colorMap: Record<AgentEvent["type"], string> = {
    reasoning: "text-blue-600 dark:text-blue-400",
    tool_call: "text-purple-600 dark:text-purple-400",
    tool_result: "text-green-600 dark:text-green-400",
    status: "text-muted-foreground",
    guardrail_warning: "text-amber-600 dark:text-amber-400",
  };
  const iconMap: Record<AgentEvent["type"], string> = {
    reasoning: "💭",
    tool_call: "🔧",
    tool_result: "✓",
    status: "ℹ",
    guardrail_warning: "⚠",
  };

  if (agentEvents.length === 0 && phase !== "executing") return null;

  if (phase === "executing" && agentEvents.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Running plan… (editing files, running commands, running tests)
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">Agent activity</div>
        <div className="text-[10px] text-muted-foreground">
          {agentEvents.length} event{agentEvents.length !== 1 ? "s" : ""}
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto space-y-1.5 text-xs font-mono">
        {agentEvents.map((event) => {
          const label = labelMap[event.type] || event.type;
          return (
            <div key={event.id} className="flex items-start gap-2 py-0.5">
              <span className={`shrink-0 font-medium ${colorMap[event.type] || "text-muted-foreground"}`}>
                {iconMap[event.type]} [{label}]
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-foreground break-words">{event.message}</div>
                {event.meta?.modelLabel && (
                  <div className="text-muted-foreground text-[10px] mt-0.5 opacity-75">
                    Model: {event.meta.modelLabel}
                    {event.meta.modelRole && ` (${event.meta.modelRole})`}
                  </div>
                )}
                {event.meta?.filePath && (
                  <div className="text-muted-foreground font-mono text-[10px] mt-0.5 opacity-75">
                    📄{" "}
                    <button
                      onClick={() => onFileClick(event.meta!.filePath!)}
                      className="underline hover:text-foreground transition-colors cursor-pointer"
                      title="Open this file"
                    >
                      {event.meta.filePath}
                    </button>
                  </div>
                )}
                {event.meta?.command && (
                  <div className="text-muted-foreground font-mono text-[10px] mt-0.5 opacity-75">
                    $ {event.meta.command}
                  </div>
                )}
                {event.meta?.toolName && !event.meta.filePath && !event.meta.command && (
                  <div className="text-muted-foreground text-[10px] mt-0.5 opacity-75">
                    Tool: {event.meta.toolName}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={eventsEndRef} />
      </div>

      {runSummary && runSummary.isComplete && (phase === "done" || (phase === "plan_ready" && runSummary.wasCancelled)) && (
        <div className="mt-3 pt-3 border-t border-border/50">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Run summary
            {runSummary.wasCancelled && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">(Cancelled)</span>
            )}
          </div>
          <div className="space-y-1.5 text-xs">
            {(runSummary.scope || runSummary.scopeMode) && (
              <div className="text-muted-foreground">
                {runSummary.scope && (
                  <span>Planned: {runSummary.scope.fileCount} file(s), ≈{runSummary.scope.approxLinesChanged} lines</span>
                )}
                {runSummary.scopeMode && (
                  <span>{runSummary.scope ? ` (mode: ${runSummary.scopeMode.charAt(0).toUpperCase() + runSummary.scopeMode.slice(1)})` : `Scope mode: ${runSummary.scopeMode}`}</span>
                )}
              </div>
            )}
            {runSummary.retried && (runSummary.attempt1 || runSummary.attempt2) && (
              <div className="text-muted-foreground">
                Attempt 1: {runSummary.attempt1?.testsPassed ? "tests passed" : "tests failed"}.
                Attempt 2: {runSummary.attempt2?.testsPassed ? "tests passed" : "tests failed"}.
              </div>
            )}
            {runSummary.editedFiles.size > 0 && (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Edited {runSummary.editedFiles.size} file(s):</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => {
                      const paths = Array.from(runSummary.editedFiles);
                      if (paths.length > 0) onFileClick(paths[0], true);
                    }}
                  >
                    Review all changes
                  </Button>
                </div>
                <p className="text-muted-foreground text-[10px] mt-1">
                  Click any file to inspect its changes, or &quot;Review all changes&quot; to start from the first edited file.
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {Array.from(runSummary.editedFiles).slice(0, 5).map((filePath) => (
                    <button
                      key={filePath}
                      onClick={() => onFileClick(filePath)}
                      className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-400 hover:bg-blue-500/20 transition-colors font-mono text-[10px] underline"
                      title="Open this file"
                    >
                      {filePath}
                    </button>
                  ))}
                  {runSummary.editedFiles.size > 5 && (
                    <span className="text-muted-foreground text-[10px] py-0.5">
                      +{runSummary.editedFiles.size - 5} more
                    </span>
                  )}
                </div>
              </div>
            )}
            {(runSummary.filesSkippedDueToConflict?.size ?? 0) > 0 && (
              <div>
                <span className="text-muted-foreground">Needs human review (file changed since planning):</span>{" "}
                <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">
                  {Array.from(runSummary.filesSkippedDueToConflict ?? []).slice(0, 5).join(", ")}
                  {(runSummary.filesSkippedDueToConflict?.size ?? 0) > 5 && ` +${(runSummary.filesSkippedDueToConflict?.size ?? 0) - 5} more`}
                </span>
              </div>
            )}
            {runSummary.commandsRun.length > 0 && (
              <div>
                <span className="text-muted-foreground">Ran {runSummary.commandsRun.length} command(s):</span>{" "}
                <span className="font-mono text-[10px]">
                  {runSummary.commandsRun.slice(0, 3).join(", ")}
                  {runSummary.commandsRun.length > 3 && ` +${runSummary.commandsRun.length - 3} more`}
                </span>
              </div>
            )}
            <div className="text-muted-foreground text-[10px] pt-1">
              Total events: {agentEvents.length} (
              {runSummary.reasoningCount > 0 && `reasoning: ${runSummary.reasoningCount}`}
              {runSummary.reasoningCount > 0 && runSummary.toolCallCount > 0 && ", "}
              {runSummary.toolCallCount > 0 && `tools: ${runSummary.toolCallCount}`}
              {runSummary.toolCallCount > 0 && runSummary.toolResultCount > 0 && ", "}
              {runSummary.toolResultCount > 0 && `results: ${runSummary.toolResultCount}`}
              )
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
