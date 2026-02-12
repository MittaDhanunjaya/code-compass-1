/**
 * Phase 4.3.1: Structured logging.
 * JSON logs with level, timestamp, requestId for observability.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogPayload = Record<string, unknown> & {
  level?: LogLevel;
  event?: string;
  requestId?: string;
  userId?: string;
  workspaceId?: string;
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
