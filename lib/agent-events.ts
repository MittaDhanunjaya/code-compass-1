/**
 * Agent event types for real-time activity feed
 */

export type AgentEventType = 'reasoning' | 'tool_call' | 'tool_result' | 'status' | 'guardrail_warning';

export interface AgentEvent {
  id: string;            // unique per event
  type: AgentEventType;
  message: string;       // human-readable text to show in UI
  meta?: {
    toolName?: string;
    filePath?: string;
    command?: string;
    stepIndex?: number;
    conflict?: boolean;
    /** When present, indicates message classification from detectErrorLogKind. */
    kind?: "normal" | "error_log";
    /** Multi-model: which model produced this event */
    modelId?: string;
    modelLabel?: string;
    modelGroupId?: string;
    modelRole?: "planner" | "coder" | "reviewer";
    /** Guardrail: large edit warning */
    guardrail?: {
      path: string;
      reason: "large_replacement_ratio" | "large_line_delta";
      ratio?: number;
      lineDelta?: number;
    };
    /** Planned run scope (file count, approx lines). */
    scope?: { fileCount: number; approxLinesChanged: number };
    /** Step count for plan complete event. */
    stepCount?: number;
    /** Scope mode used for this run. */
    scopeMode?: "conservative" | "normal" | "aggressive";
    /** Debug-from-log retry. */
    retried?: boolean;
    retryReason?: string;
    attempt1?: { testsPassed: boolean; logs?: string };
    attempt2?: { testsPassed: boolean; logs?: string };
  };
  createdAt: string;     // ISO timestamp
}

/**
 * Helper to create an agent event
 */
export function createAgentEvent(
  type: AgentEventType,
  message: string,
  meta?: AgentEvent['meta']
): AgentEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    message,
    meta,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Stream event format: each line is a JSON object
 * Format: "data: <JSON>\n\n"
 * 3.3.5: Never emit malformed JSON - validate before emitting.
 */
export function formatStreamEvent(event: AgentEvent): string {
  try {
    const json = JSON.stringify(event);
    return `data: ${json}\n\n`;
  } catch {
    // Fallback: emit minimal valid event with error indicator
    return `data: ${JSON.stringify({
      id: `${Date.now()}-fallback`,
      type: "status" as const,
      message: "Event serialization error",
      createdAt: new Date().toISOString(),
    })}\n\n`;
  }
}
