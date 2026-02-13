/**
 * Phase 1 Agent: JSON plan types for file edits and command steps.
 * Used by plan-generation API and execution loop.
 */

export type FileEditStep = {
  type: "file_edit";
  path: string;
  /** Optional: exact snippet to replace (for merge). If omitted, treat as full replace. */
  oldContent?: string;
  /** New content for the file (or replacement for oldContent). */
  newContent: string;
  /** Optional human-readable description. */
  description?: string;
  /** When "debug-from-log", conflict messages can be tailored for that flow. */
  source?: "debug-from-log";
};

export type CommandStep = {
  type: "command";
  /** Shell command (e.g. "npm install", "npm test"). */
  command: string;
  /** Optional description. */
  description?: string;
};

export type PlanStep = FileEditStep | CommandStep;

export type PlanFileDeclaration = {
  path: string;
  purpose: string;
};

export type AgentPlan = {
  steps: PlanStep[];
  /** Optional short summary of the plan. */
  summary?: string;
  /** Optional: declared files (path + purpose). When present, every file_edit step path must be in this list. */
  files?: PlanFileDeclaration[];
  /** Optional: architecture hint (monolith, microservices, serverless). */
  architecture?: string;
  /** Optional: stack hints (frontend, backend, database). */
  stack?: string[];
};

/** Command result status (for failure detection). */
export type CommandResultStatus = "success" | "failed" | "blocked" | "timeout";

/** Command kind (setup / test / other). */
export type CommandKind = "setup" | "test" | "other";

/** Short action label for execution log (EDIT, CMD-SETUP, CMD-TEST, etc.). */
export type LogActionLabel =
  | "EDIT"
  | "CMD-SETUP"
  | "CMD-TEST"
  | "CMD-OTHER"
  | "AUTO-FIX"
  | "SUMMARY";

/** Structured execution error (from classifyExecutionError). */
export type StructuredExecutionErrorRef = {
  errorType: string;
  missingDependency?: string;
  failingFile?: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

/** Execution log entry. */
export type AgentLogEntry = {
  stepIndex: number;
  type: "file_edit" | "command" | "info";
  status?: "ok" | "skipped" | "error";
  message: string;
  path?: string;
  command?: string;
  /** Command classification (when type === "command"). */
  commandKind?: CommandKind;
  commandStatus?: CommandResultStatus;
  commandStatusSummary?: string;
  /** Structured error (when command failed). */
  structuredError?: StructuredExecutionErrorRef;
  /** Self-debug: one auto-fix attempt for failed test commands. */
  autoFixAttempted?: boolean;
  secondRunStatus?: CommandResultStatus;
  secondRunSummary?: string;
  /** Short label for UI (EDIT, CMD-SETUP, CMD-TEST, AUTO-FIX, etc.). */
  actionLabel?: LogActionLabel;
  /** One-line human-readable status for UI. */
  statusLine?: string;
};

/** Sandbox check result (lint, tests, run). */
export type SandboxCheckItem = {
  status: "passed" | "failed" | "skipped" | "not_configured";
  logs?: string;
};

/** Pending review file edit. */
export type PendingReviewEdit = {
  path: string;
  originalContent?: string;
  newContent: string;
};

/** Result of running the agent execution loop. */
export type AgentExecuteResult = {
  log: AgentLogEntry[];
  summary: string;
  filesEdited: string[];
  /** File paths where edit was skipped due to conflict (file changed since planning). */
  filesSkippedDueToConflict?: string[];
  /** Sandbox check results (lint, tests, run). */
  sandboxChecks?: {
    lint?: SandboxCheckItem;
    tests?: SandboxCheckItem;
    run?: SandboxCheckItem & { port?: number };
  };
  /** Pending review edits (applied after user accepts). */
  pendingReview?: { fileEdits?: PendingReviewEdit[] };
};

/** Scope mode for planning: limits how many files/lines can be changed. */
export type ScopeMode = "conservative" | "normal" | "aggressive";
