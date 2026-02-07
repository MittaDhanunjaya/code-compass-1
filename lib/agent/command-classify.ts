/**
 * v1 command/test classification and result status for Agent.
 * Simple pattern matching only.
 */

import type { RunCommandResult } from "@/lib/agent/execute-command-server";

export type CommandKind = "setup" | "test" | "other";

/** Pattern-based classification of command intent. */
export function classifyCommandKind(command: string): CommandKind {
  const c = command.trim().toLowerCase();
  // setup: install, pip install, npm install, yarn install, pnpm install, venv
  if (
    /^(npm|yarn|pnpm)\s+install/.test(c) ||
    /^(pip|pip3|venv\/bin\/pip)\s+install/.test(c) ||
    /^python3\s+-m\s+venv/.test(c)
  ) {
    return "setup";
  }
  // test: npm test, npm run test, pytest, etc.
  if (
    /^(npm|yarn|pnpm)\s+test\b/.test(c) ||
    /^(npm|yarn|pnpm)\s+run\s+test/.test(c) ||
    /^(npm|yarn|pnpm)\s+run\s+test:/.test(c) ||
    /^pytest\b/.test(c) ||
    /^venv\/bin\/pytest\b/.test(c) ||
    /^node\s+.*test/.test(c) ||
    /^npx\s+.*test/.test(c)
  ) {
    return "test";
  }
  return "other";
}

export type CommandResultStatus = "success" | "failed" | "blocked" | "timeout";

export type CommandResultClassification = {
  status: CommandResultStatus;
  summary: string;
};

/** Classify runCommand() result for logging and self-debug trigger. */
export function classifyCommandResult(cmdResult: RunCommandResult): CommandResultClassification {
  if (cmdResult.errorMessage) {
    const lower = cmdResult.errorMessage.toLowerCase();
    if (lower.includes("timed out") || lower.includes("timeout")) {
      return { status: "timeout", summary: "Command timed out (60s)" };
    }
    if (lower.includes("blocked") || lower.includes("allowlist") || lower.includes("not in the allowlist")) {
      return { status: "blocked", summary: "Command blocked (allowlist)" };
    }
    return { status: "failed", summary: cmdResult.errorMessage.slice(0, 120) };
  }
  if (cmdResult.exitCode === null) {
    return { status: "timeout", summary: "Command timed out (60s)" };
  }
  if (cmdResult.exitCode === 0) {
    return { status: "success", summary: "OK" };
  }
  return {
    status: "failed",
    summary: `Exit code ${cmdResult.exitCode}`,
  };
}
