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

export type AgentPlan = {
  steps: PlanStep[];
  /** Optional short summary of the plan. */
  summary?: string;
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
  /** Self-debug: one auto-fix attempt for failed test commands. */
  autoFixAttempted?: boolean;
  secondRunStatus?: CommandResultStatus;
  secondRunSummary?: string;
  /** Short label for UI (EDIT, CMD-SETUP, CMD-TEST, AUTO-FIX, etc.). */
  actionLabel?: LogActionLabel;
  /** One-line human-readable status for UI. */
  statusLine?: string;
};

/** Result of running the agent execution loop. */
export type AgentExecuteResult = {
  log: AgentLogEntry[];
  summary: string;
  filesEdited: string[];
  /** File paths where edit was skipped due to conflict (file changed since planning). */
  filesSkippedDueToConflict?: string[];
};

/** Scope mode for planning: limits how many files/lines can be changed. */
export type ScopeMode = "conservative" | "normal" | "aggressive";
