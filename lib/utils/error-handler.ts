/**
 * Robust error handling utilities.
 * Provides structured error reporting and recovery strategies.
 */

export type ErrorSeverity = "low" | "medium" | "high" | "critical";
export type ErrorCategory =
  | "parsing"
  | "api"
  | "database"
  | "validation"
  | "execution"
  | "unknown";

export interface StructuredError {
  message: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  code?: string;
  details?: Record<string, any>;
  stack?: string;
  recoverable: boolean;
  timestamp: number;
}

/**
 * Create a structured error object.
 */
export function createStructuredError(
  error: Error | string,
  category: ErrorCategory = "unknown",
  severity: ErrorSeverity = "medium",
  details?: Record<string, any>
): StructuredError {
  const message = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : undefined;

  return {
    message,
    category,
    severity,
    details,
    stack,
    recoverable: severity !== "critical",
    timestamp: Date.now(),
  };
}

/**
 * Log error with proper structure.
 */
export function logError(
  error: StructuredError | Error | string,
  context?: Record<string, any>
): StructuredError {
  const structured =
    typeof error === "string" || error instanceof Error
      ? createStructuredError(error, "unknown", "medium", context)
      : error;

  // Log to console with proper formatting
  const logLevel =
    structured.severity === "critical"
      ? "error"
      : structured.severity === "high"
      ? "error"
      : structured.severity === "medium"
      ? "warn"
      : "log";

  console[logLevel](
    `[${structured.category.toUpperCase()}] ${structured.message}`,
    structured.details || context || ""
  );

  if (structured.stack && structured.severity !== "low") {
    console[logLevel](structured.stack);
  }

  return structured;
}

/**
 * Handle errors with recovery strategies.
 */
export async function handleErrorWithRecovery<T>(
  operation: () => Promise<T>,
  recovery: (error: StructuredError) => Promise<T | null>,
  context?: Record<string, any>
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const structured = logError(error, context);
    
    if (structured.recoverable && recovery) {
      try {
        return await recovery(structured);
      } catch (recoveryError) {
        logError(recoveryError, { ...context, recoveryFailed: true });
        return null;
      }
    }

    return null;
  }
}

/**
 * Retry operation with exponential backoff.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffFactor = 2,
    onRetry,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = Math.min(
          initialDelay * Math.pow(backoffFactor, attempt),
          maxDelay
        );

        if (onRetry) {
          onRetry(attempt + 1, lastError);
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Retry failed");
}

/**
 * Check if error is recoverable.
 */
export function isRecoverableError(error: StructuredError | Error | string): boolean {
  if (typeof error === "string") return true;
  
  const structured =
    error instanceof Error
      ? createStructuredError(error)
      : error;

  // Network errors are usually recoverable
  if (structured.message.includes("network") || structured.message.includes("timeout")) {
    return true;
  }

  // Parse errors might be recoverable with fallback
  if (structured.category === "parsing") {
    return true;
  }

  // API rate limits are recoverable
  if (structured.message.includes("rate limit") || structured.message.includes("429")) {
    return true;
  }

  return structured.recoverable;
}
