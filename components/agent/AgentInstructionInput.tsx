"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2, Play } from "lucide-react";
import { PLAYBOOKS } from "@/lib/playbooks";
import { looksLikeLog, createLogAttachment } from "@/lib/chat/log-utils";
import type { LogAttachment } from "@/lib/chat/log-utils";
import type { ScopeMode } from "@/lib/agent/types";

type AgentPhase = "idle" | "loading_plan" | "plan_ready" | "executing" | "done";

type AgentInstructionInputProps = {
  instruction: string;
  setInstruction: React.Dispatch<React.SetStateAction<string>>;
  scopeMode: ScopeMode;
  setScopeMode: (m: ScopeMode) => void;
  phase: AgentPhase;
  logAttachment: LogAttachment | null;
  setLogAttachment: (a: LogAttachment | null) => void;
  useDebugForLogs: boolean;
  workspaceId: string | null;
  onStartPlan: () => void;
};

export function AgentInstructionInput({
  instruction,
  setInstruction,
  scopeMode,
  setScopeMode,
  phase,
  logAttachment,
  setLogAttachment,
  useDebugForLogs,
  workspaceId,
  onStartPlan,
}: AgentInstructionInputProps) {
  const canStart = instruction.trim() || logAttachment;
  const isDisabled = phase === "loading_plan" || phase === "executing";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="text-xs font-medium text-muted-foreground">Instruction</label>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Scope:</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs min-w-[100px]">
                {scopeMode === "conservative" ? "Conservative" : scopeMode === "aggressive" ? "Aggressive" : "Normal"}
                {" ▼"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setScopeMode("conservative")} className={scopeMode === "conservative" ? "bg-accent" : ""}>
                Conservative
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setScopeMode("normal")} className={scopeMode === "normal" ? "bg-accent" : ""}>
                Normal
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setScopeMode("aggressive")} className={scopeMode === "aggressive" ? "bg-accent" : ""}>
                Aggressive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="text-[10px] text-muted-foreground hidden sm:inline">(whole workspace)</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground">
                Playbooks
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-xs">
              {PLAYBOOKS.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => setInstruction(p.instruction)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="font-medium">{p.title}</span>
                  <span className="text-xs text-muted-foreground line-clamp-2">{p.description}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <Textarea
        placeholder="e.g. Add a README with setup instructions. Paste terminal logs to format with line numbers."
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData?.getData("text");
          const fromTerminal = e.clipboardData?.types?.includes("application/x-aiforge-terminal");
          if (fromTerminal && pasted && pasted.includes("\n")) {
            e.preventDefault();
            if (looksLikeLog(pasted)) {
              setLogAttachment(createLogAttachment(pasted));
              setInstruction((prev) => prev || "Here's the error I'm seeing.");
            } else {
              const lines = pasted.trim().split(/\r?\n/);
              const formatted =
                `Terminal (lines 1-${lines.length}):\n` +
                lines.map((l, i) => `[${i + 1}] ${l}`).join("\n");
              const ta = e.target as HTMLTextAreaElement;
              if (ta && typeof ta.selectionStart === "number") {
                const start = ta.selectionStart;
                const end = ta.selectionEnd ?? instruction.length;
                setInstruction(instruction.slice(0, start) + formatted + instruction.slice(end));
              } else {
                setInstruction(formatted);
              }
            }
          } else if (pasted && looksLikeLog(pasted)) {
            e.preventDefault();
            setLogAttachment(createLogAttachment(pasted));
            setInstruction((prev) => prev || "Here's the error I'm seeing.");
          }
        }}
        disabled={isDisabled}
        title={isDisabled ? "Finish or reset the current run to edit the task" : undefined}
        className="min-h-[80px] resize-none text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onStartPlan();
          }
        }}
      />
      {logAttachment && (
        <div className="inline-flex items-center gap-2 rounded bg-slate-800 px-2 py-1 text-xs text-slate-100 dark:bg-slate-700">
          <span>
            🖥 {logAttachment.source ?? "log"} ({logAttachment.lineCount} lines)
          </span>
          <button
            type="button"
            onClick={() => setLogAttachment(null)}
            className="text-slate-300 hover:text-slate-100"
            aria-label="Remove log"
          >
            ×
          </button>
        </div>
      )}
      {logAttachment && useDebugForLogs && workspaceId && (
        <div className="text-xs text-muted-foreground">
          Log detected – will run <strong>Debug-from-log</strong> on this workspace.
        </div>
      )}
      <Button
        className="w-full gap-2"
        onClick={onStartPlan}
        disabled={!canStart || phase === "loading_plan" || phase === "executing"}
        title={
          !canStart
            ? "Enter a task or paste logs"
            : phase === "loading_plan" || phase === "executing"
              ? "Wait for the current step to finish"
              : undefined
        }
      >
        {phase === "loading_plan" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Planning…
          </>
        ) : (
          <>
            <Play className="h-4 w-4" />
            Start
          </>
        )}
      </Button>
    </div>
  );
}
