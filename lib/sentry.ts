/**
 * Phase 4.3.5: Sentry-compatible error boundary.
 * When SENTRY_DSN is set, captures errors. Otherwise logs to console.
 * Add @sentry/nextjs for full integration: npm install @sentry/nextjs
 */

let sentryCapture: ((error: Error, context?: Record<string, unknown>) => void) | null = null;

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
 */
export async function captureException(
  error: unknown,
  context?: Record<string, unknown>
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
export function captureExceptionSync(error: unknown, context?: Record<string, unknown>): void {
  initSentry().then(() => {
    const err = error instanceof Error ? error : new Error(String(error));
    if (sentryCapture) sentryCapture(err, context);
  });
}
