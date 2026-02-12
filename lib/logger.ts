/**
 * Phase 4.3.1 & 12.1: Structured logging.
 * JSON logs with level, timestamp, requestId for observability.
 * Use logger instead of console.log in production code.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogPayload = Record<string, unknown> & {
  level?: LogLevel;
  event?: string;
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  instruction?: string;
  scopeMode?: string;
  message?: string;
  timestamp?: string;
};

function emit(level: LogLevel, payload: LogPayload): void {
  if (process.env.NODE_ENV === "test") return;

  const entry: LogPayload = {
    ...payload,
    level,
    timestamp: payload.timestamp ?? new Date().toISOString(),
  };

  const line = JSON.stringify(entry);
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

export const logger = {
  debug: (payload: LogPayload) => emit("debug", payload),
  info: (payload: LogPayload) => emit("info", payload),
  warn: (payload: LogPayload) => emit("warn", payload),
  error: (payload: LogPayload) => emit("error", payload),
};

/**
 * Phase 12.1.3: Log agent context (workspaceId, instruction, scopeMode).
 */
export function logAgentStarted(opts: {
  phase: "plan" | "execute";
  workspaceId: string;
  userId: string;
  instruction?: string;
  scopeMode?: string;
  stepCount?: number;
  requestId?: string;
}): void {
  logger.info({
    event: "agent_started",
    phase: opts.phase,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    requestId: opts.requestId,
    instruction: opts.instruction ? opts.instruction.slice(0, 200) + (opts.instruction.length > 200 ? "…" : "") : undefined,
    scopeMode: opts.scopeMode,
    stepCount: opts.stepCount,
  });
}

/**
 * Phase 12.2.2: Log agent execution completed with timing.
 */
export function logAgentCompleted(opts: {
  phase: "plan" | "execute";
  workspaceId: string;
  userId: string;
  durationMs: number;
  success: boolean;
  error?: string;
  requestId?: string;
}): void {
  logger.info({
    event: "agent_completed",
    phase: opts.phase,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    requestId: opts.requestId,
    durationMs: opts.durationMs,
    success: opts.success,
    error: opts.error,
  });
}

/**
 * Log tool execution for observability. Phase 15.1.
 */
export function logToolExecution(opts: {
  toolName: string;
  userId?: string;
  workspaceId?: string;
  durationMs: number;
  success: boolean;
  requestId?: string;
  command?: string;
}): void {
  if (process.env.NODE_ENV === "test") return;
  logger.info({
    event: "tool_execution",
    toolName: opts.toolName,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    durationMs: opts.durationMs,
    success: opts.success,
    requestId: opts.requestId,
    command: opts.command?.slice(0, 200),
  });
}

/**
 * Phase 4.3.2: Generate or extract request trace ID.
 * Use x-request-id from incoming request, or generate a new one.
 */
export function getRequestId(request?: Request): string {
  if (request) {
    const existing = request.headers.get("x-request-id");
    if (existing) return existing;
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
