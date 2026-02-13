"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronRight, Bug, Clock, AlertTriangle } from "lucide-react";
import type { PlanDebugInfo } from "@/hooks/useAgentPlan";

type AgentDebugPanelProps = {
  debugInfo: PlanDebugInfo | null;
  className?: string;
};

export function AgentDebugPanel({ debugInfo, className = "" }: AgentDebugPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (!debugInfo) return null;

  const tokensUsedStr =
    debugInfo.tokensUsed &&
    (debugInfo.tokensUsed.total != null
      ? `${debugInfo.tokensUsed.total.toLocaleString()} used`
      : debugInfo.tokensUsed.input != null || debugInfo.tokensUsed.output != null
        ? `In: ${debugInfo.tokensUsed.input?.toLocaleString() ?? "—"} / Out: ${debugInfo.tokensUsed.output?.toLocaleString() ?? "—"}`
        : null);

  return (
    <div className={`rounded-lg border border-border/60 bg-muted/30 ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors rounded-lg"
        aria-expanded={expanded}
      >
        <Bug className="h-3.5 w-3.5 shrink-0" />
        <span>Debug</span>
        {!expanded && (
          <span className="truncate text-muted-foreground/80">
            {debugInfo.modelUsed} • {debugInfo.streamDurationMs}ms
          </span>
        )}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 ml-auto shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 ml-auto shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-0 space-y-2 text-[11px] border-t border-border/40 pt-2 mt-0">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-muted-foreground">Model</span>
            <span className="font-mono text-foreground/90 truncate" title={debugInfo.modelUsed}>
              {debugInfo.modelUsed}
            </span>
            <span className="text-muted-foreground">Tokens reserved</span>
            <span>{debugInfo.tokensReserved.toLocaleString()}</span>
            {tokensUsedStr && (
              <>
                <span className="text-muted-foreground">Tokens used</span>
                <span>{tokensUsedStr}</span>
              </>
            )}
            <span className="text-muted-foreground">Stream duration</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {debugInfo.streamDurationMs}ms
            </span>
            {debugInfo.fallbackReason && (
              <>
                <span className="text-muted-foreground">Fallback</span>
                <span className="text-amber-600 dark:text-amber-500">
                  {debugInfo.fallbackReason === "rate_limit" ? "Rate limit" : "Capability"}
                </span>
              </>
            )}
          </div>
          {debugInfo.providerErrors.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-500 font-medium">
                <AlertTriangle className="h-3 w-3" />
                Provider errors
              </div>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {debugInfo.providerErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
