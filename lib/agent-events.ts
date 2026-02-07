/**
 * Agent event types for real-time activity feed
 */

export type AgentEventType = 'reasoning' | 'tool_call' | 'tool_result' | 'status';

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
 */
export function formatStreamEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
