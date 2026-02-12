/**
 * Phase 4.3.5 & 12.3: Sentry-compatible error tracking.
 * When SENTRY_DSN is set, captures errors with extra context (workspaceId, operation).
 * Add @sentry/nextjs for full integration: npm install @sentry/nextjs
 */

export type CaptureContext = Record<string, unknown> & {
  workspaceId?: string;
  operation?: string;
  userId?: string;
  requestId?: string;
};

let sentryCapture: ((error: Error, context?: CaptureContext) => void) | null = null;

async function initSentry(): Promise<void> {
  if (sentryCapture) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    sentryCapture = () => {}; // No-op
    return;
  }
  try {
    const Sentry = await import("@sentry/nextjs");
    sentryCapture = (error, context) => {
      Sentry.captureException(error, { extra: context });
    };
  } catch {
    sentryCapture = (error, context) => {
      if (process.env.NODE_ENV !== "test") {
        console.error("[Sentry] Cannot load @sentry/nextjs. Install: npm install @sentry/nextjs");
        console.error(error, context);
      }
    };
  }
}

/**
 * Capture an exception for observability.
 * Call from catch blocks or error boundaries.
 * Phase 12.3.2: Include workspaceId, operation in context when available.
 */
export async function captureException(
  error: unknown,
  context?: CaptureContext
): Promise<void> {
  await initSentry();
  const err = error instanceof Error ? error : new Error(String(error));
  if (sentryCapture) {
    sentryCapture(err, context);
  }
}

/**
 * Sync version for use in error boundaries (e.g. React error boundary).
 * Fire-and-forget; does not block.
 */
export function captureExceptionSync(error: unknown, context?: CaptureContext): void {
  initSentry().then(() => {
    const err = error instanceof Error ? error : new Error(String(error));
    if (sentryCapture) sentryCapture(err, context);
  });
}
