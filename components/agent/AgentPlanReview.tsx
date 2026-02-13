"use client";

import React from "react";
import { FileEdit, Terminal } from "lucide-react";
import type { AgentPlan, PlanStep, FileEditStep, CommandStep } from "@/lib/agent/types";
import type { ProviderId } from "@/lib/llm/providers";
import { PROVIDER_LABELS } from "@/lib/llm/providers";

const PlanStepItem = React.memo(function PlanStepItem({
  step,
  index,
}: {
  step: PlanStep;
  index: number;
}) {
  const stepContent =
    step.type === "file_edit"
      ? (step.path || "(no path specified)")
      : (step.command || "(no command specified)");
  return (
    <li className="flex items-start gap-2">
      <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded bg-muted/80 text-[10px] font-medium text-muted-foreground">
        {index + 1}
      </span>
      {step.type === "file_edit" ? (
        <FileEdit className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
      ) : (
        <Terminal className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
      )}
      <span className="flex-1 min-w-0">
        <span
          className={
            !(step as FileEditStep).path && !(step as CommandStep).command
              ? "text-destructive/70"
              : ""
          }
        >
          {stepContent}
        </span>
        {step.description && (
          <span className="block text-muted-foreground text-[11px] mt-0.5">Why: {step.description}</span>
        )}
        {step.type === "file_edit" && !step.path && (
          <span className="text-destructive/70 text-xs ml-1">
            (invalid step: missing path)
          </span>
        )}
        {step.type === "command" && !step.command && (
          <span className="text-destructive/70 text-xs ml-1">
            (invalid step: missing command)
          </span>
        )}
      </span>
    </li>
  );
});

type AgentPlanReviewProps = {
  plan: AgentPlan;
  runScope: { fileCount: number; approxLinesChanged: number } | null;
  planUsage: string | null;
  planContextUsed: string[] | null;
  provider: ProviderId;
};

export function AgentPlanReview({
  plan,
  runScope,
  planUsage,
  planContextUsed,
  provider,
}: AgentPlanReviewProps) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-muted/20 p-3 max-h-[min(65vh,520px)] min-h-0">
      <div className="shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground flex-wrap">
          <span className="font-medium">
            Plan ({plan.steps.length} steps) — runs in order 1→{plan.steps.length}
            {runScope ? ` • ${runScope.fileCount} file(s), ≈${runScope.approxLinesChanged} lines` : ""} • {PROVIDER_LABELS[provider]}
          </span>
          {planUsage && (
            <span className="rounded bg-background/60 px-2 py-0.5">
              {planUsage}
            </span>
          )}
        </div>
        {planContextUsed && planContextUsed.length > 0 && (
          <div className="rounded bg-background/40 px-2 py-1 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/80">Context used: </span>
            {planContextUsed.slice(0, 8).map((p) => (
              <span key={p} className="font-mono truncate inline-block max-w-[180px] align-bottom mr-1" title={p}>{p}</span>
            ))}
            {planContextUsed.length > 8 && <span>+{planContextUsed.length - 8} more</span>}
          </div>
        )}
        {plan.summary && (
          <p className="text-sm text-muted-foreground">{plan.summary}</p>
        )}
      </div>
      <ul className="flex-1 min-h-0 space-y-1.5 text-sm overflow-y-auto overflow-x-hidden pr-1 mt-2">
        {plan.steps && plan.steps.length > 0 ? (
          plan.steps.map((step: PlanStep, i: number) => (
            <PlanStepItem key={i} step={step} index={i} />
          ))
        ) : (
          <li className="text-sm text-muted-foreground italic">
            No steps available (plan may be malformed)
          </li>
        )}
      </ul>
    </div>
  );
}
