/**
 * Enhanced self-debugging with multiple retry attempts and better error parsing.
 */

import { proposeFixSteps, buildTails, type SelfDebugContext } from "./self-debug";
import type { FileEditStep } from "./types";
import type { ProviderId } from "@/lib/llm/providers";

export type SelfDebugAttempt = {
  attempt: number;
  steps: FileEditStep[];
  result: { status: "success" | "failed" | "blocked" | "timeout"; summary: string };
};

export type EnhancedSelfDebugOptions = {
  apiKey: string;
  providerId: ProviderId;
  model?: string;
  maxAttempts?: number; // Default: 5
};

/**
 * Enhanced self-debugging with multiple retry attempts.
 * Tries up to maxAttempts times, learning from previous failures.
 */
export async function enhancedSelfDebug(
  command: string,
  stdout: string,
  stderr: string,
  filesEdited: string[],
  executeCommandFn: (command: string) => Promise<{
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>,
  options: EnhancedSelfDebugOptions
): Promise<{
  success: boolean;
  attempts: SelfDebugAttempt[];
  finalSteps: FileEditStep[];
}> {
  const maxAttempts = options.maxAttempts ?? 5;
  const attempts: SelfDebugAttempt[] = [];
  const previousAttempts: SelfDebugContext["previousAttempts"] = [];

  // Parse error patterns for better context
  const { stdoutTail, stderrTail } = buildTails(stdout, stderr, 150);
  
  // Extract error patterns
  const errorPatterns = extractErrorPatterns(stdout, stderr);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const context: SelfDebugContext = {
      command,
      stdoutTail,
      stderrTail,
      filesEdited,
      previousAttempts: previousAttempts.length > 0 ? previousAttempts : undefined,
    };

    // Add error pattern hints if available
    if (errorPatterns.length > 0 && attempt === 1) {
      context.stdoutTail = `${context.stdoutTail}\n\nDetected error patterns: ${errorPatterns.join(", ")}`;
    }

    const fixSteps = await proposeFixSteps(context, options);

    if (fixSteps.length === 0) {
      // No fix proposed, stop trying
      attempts.push({
        attempt,
        steps: [],
        result: { status: "failed", summary: "No fix proposed" },
      });
      break;
    }

    // Apply fixes (this would be done by the caller in practice)
    // For now, we'll return the steps and let the caller apply them
    
    // Simulate execution (caller should actually run the command)
    // This is a placeholder - the actual execution happens in the agent execute route
    attempts.push({
      attempt,
      steps: fixSteps,
      result: { status: "failed", summary: "Fix applied, awaiting execution result" },
    });

    // Note: The actual command execution and result checking happens in the agent execute route
    // This function just proposes fixes with retry logic
    break; // For now, return first attempt - actual retry loop happens in execute route
  }

  return {
    success: attempts.length > 0 && attempts[attempts.length - 1].steps.length > 0,
    attempts,
    finalSteps: attempts.length > 0 ? attempts[attempts.length - 1].steps : [],
  };
}

/**
 * Extract common error patterns from stdout/stderr for better debugging.
 */
function extractErrorPatterns(stdout: string, stderr: string): string[] {
  const patterns: string[] = [];
  const combined = `${stdout}\n${stderr}`.toLowerCase();

  // Port conflict detection (high priority)
  const portMatch = combined.match(/port\s+(\d+)\s+is\s+already\s+in\s+use/i) || 
                    combined.match(/address\s+already\s+in\s+use.*?(\d+)/i) ||
                    combined.match(/eaddrinuse.*?(\d+)/i);
  if (portMatch) {
    patterns.push(`port conflict: port ${portMatch[1]} is already in use`);
  }

  // Common error patterns
  if (combined.includes("cannot find module") || combined.includes("module not found")) {
    patterns.push("missing import/module");
  }
  if (combined.includes("cannot read property") || combined.includes("undefined")) {
    patterns.push("undefined reference");
  }
  if (combined.includes("syntax error") || combined.includes("unexpected token")) {
    patterns.push("syntax error");
  }
  if (combined.includes("type error") || combined.includes("type mismatch")) {
    patterns.push("type error");
  }
  if (combined.includes("test failed") || combined.includes("assertion error")) {
    patterns.push("test failure");
  }
  if (combined.includes("permission denied") || combined.includes("eacces")) {
    patterns.push("permission error");
  }
  if (combined.includes("timeout") || combined.includes("timed out")) {
    patterns.push("timeout");
  }
  if (combined.includes("connection refused") || combined.includes("econnrefused")) {
    patterns.push("connection error");
  }

  return patterns;
}
