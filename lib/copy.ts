/**
 * Short, consistent copy for safety prompts, debug-from-log, and conflict warnings.
 * Keeps UX clear and non-verbose.
 */

export const COPY = {
  /** Protected files (safety) */
  safety: {
    title: "Edit protected files?",
    body: (paths: string[]) =>
      paths.length === 1
        ? `"${paths[0]}" is protected (e.g. secrets or config). Allow edit?`
        : `${paths.length} protected files. Allow edit?`,
    allow: "Allow once",
    cancel: "Cancel",
  },

  /** Edit conflict (file changed since planning) */
  conflict: {
    single: (path: string) => `"${path}" changed since planning. Re-run or review manually.`,
    multiple: (paths: string[]) =>
      `${paths.length} file(s) changed. Re-run with updated context or review manually.`,
  },

  /** Debug-from-log specific */
  debug: {
    applying: "Applying fixes…",
    applied: "Fixes applied.",
    sandboxFailed: "Checks failed. Review changes before applying.",
    noEdits: "No edits proposed. Try describing the error or paste more context.",
  },

  /** Generic errors with actions */
  error: {
    apiKey: "Add an API key in Settings.",
    rateLimit: "Rate limit reached. Try another model or add a key in Settings.",
    connectionLost: "Connection lost. Check network and try again.",
  },
} as const;
