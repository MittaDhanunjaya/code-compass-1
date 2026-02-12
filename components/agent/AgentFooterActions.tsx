"use client";

import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";

type AgentFooterActionsProps = {
  phase: "idle" | "loading_plan" | "plan_ready" | "executing" | "done";
  plan: { steps: unknown[] } | null;
  onApprove: () => void;
  onReject: () => void;
  onRerun: () => void;
};

export function AgentFooterActions({
  phase,
  plan,
  onApprove,
  onReject,
  onRerun,
}: AgentFooterActionsProps) {
  return (
    <>
      {phase === "done" && (
        <div className="shrink-0 min-h-[52px] border-t border-border bg-background px-3 py-2 flex items-center gap-2 flex-wrap shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] dark:shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.3)]">
          <Button size="sm" variant="outline" onClick={onRerun}>
            Rerun
          </Button>
        </div>
      )}

      {phase === "plan_ready" && plan && (
        <div className="shrink-0 min-h-[52px] border-t border-border bg-background px-3 py-2 flex items-center gap-2 flex-wrap shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] dark:shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.3)]">
          <Button size="sm" className="gap-1" onClick={onApprove}>
            <Check className="h-3.5 w-3.5" />
            Approve
          </Button>
          <Button size="sm" variant="outline" className="gap-1" onClick={onReject}>
            <X className="h-3.5 w-3.5" />
            Reject
          </Button>
        </div>
      )}
    </>
  );
}
