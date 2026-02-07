/**
 * Execute a command safely in the workspace context.
 * Calls the backend API endpoint that enforces safety constraints.
 */

export type RunCommandResult = {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage?: string;
  durationMs: number;
};

/**
 * Execute a command in the workspace.
 * This calls the backend API which enforces safety constraints and executes
 * the command in a workspace-scoped directory.
 */
export async function runCommand(
  workspaceId: string,
  command: string,
  signal?: AbortSignal
): Promise<RunCommandResult> {
  try {
    const res = await fetch("/api/agent/run-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, command }),
      signal,
    });

    const data = await res.json();
    
    if (!res.ok) {
      return {
        ok: false,
        command,
        exitCode: null,
        stdout: "",
        stderr: "",
        errorMessage: data.error || "Failed to execute command",
        durationMs: 0,
      };
    }

    return data as RunCommandResult;
  } catch (error) {
    return {
      ok: false,
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      errorMessage: error instanceof Error ? error.message : "Network error",
      durationMs: 0,
    };
  }
}
