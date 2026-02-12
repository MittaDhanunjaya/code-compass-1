import { createClient } from "@/lib/supabase/server";
import { getToolTimeoutMs } from "@/services/tools/registry";
import { logToolExecution } from "@/lib/logger";
import { spawn } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join, dirname, resolve } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";

const COMMAND_TIMEOUT_MS = 60000; // 60 seconds
const SERVER_COMMAND_TIMEOUT_MS = 3600000; // 1 hour for server processes

// In-memory storage for active virtual environments per workspace
// Maps workspaceId -> venv path (e.g., "venv" or ".venv")
const activeVenvs = new Map<string, string>();

// Commands that typically run as long-lived servers
const SERVER_COMMAND_PATTERNS = [
  /\bpython.*\.py/i, // python app.py, venv/bin/python main.py, etc.
  /\bpython3.*\.py/i,
  /\bflask\s+run/i,
  /\bdjango.*runserver/i,
  /\bnpm\s+start/i,
  /\bnpm\s+run\s+dev/i,
  /\byarn\s+start/i,
  /\byarn\s+dev/i,
  /\bnode.*server/i,
  /\buvicorn/i,
  /\bgunicorn/i,
  /\brails\s+server/i,
];

function isServerCommand(command: string): boolean {
  return SERVER_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export type RunCommandResult = {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage?: string;
  durationMs: number;
};

const ALLOWED_BASE_COMMANDS = [
  "npm",
  "yarn",
  "pnpm",
  "node",
  "npx",
  "python",
  "python3",
  "pip",
  "pip3",
  "pytest",
  "docker",
  "docker-compose",
  "ls",
  "pwd",
  "cat",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "lsof",  // For port/process management
  "kill",  // For killing processes (restricted to safe patterns)
  "xargs", // For piping commands (used with lsof/kill)
  // Special handling below for `source` (venv activation) and `deactivate`; not real binaries.
  "source",
  "deactivate",
];

const BLOCKED_PATTERNS = [
  /rm\s+/i,
  /rmdir/i,
  /del\s+/i,
  /delete\s+/i,
  /curl/i,
  /wget/i,
  /ssh/i,
  /scp/i,
  /nc\s+/i,
  /netcat/i,
  /cat\s+>/i,
  /echo\s+>/i,
  />>/,
  />\s+/,
  /sudo/i,
  /su\s+/i,
  /chmod/i,
  /chown/i,
  /\|\s*bash/i,
  /\|\s*sh/i,
];

function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const trimmed = command.trim();
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Command contains blocked pattern: ${pattern}` };
    }
  }
  
  // Allow safe pipe chains for port cleanup: lsof -ti:PORT | xargs kill -9
  // Pattern: lsof with port flag, piped to xargs kill
  const safePipePattern = /^lsof\s+-ti:\d+\s*\|\s*xargs\s+kill\s+(-9|-TERM|-KILL)?(\s*\|\|\s*true)?$/i;
  if (safePipePattern.test(trimmed)) {
    return { allowed: true };
  }
  
  // Allow command substitution for port cleanup: kill -9 $(lsof -t -i:PORT)
  // Pattern: kill with -9 flag, using $(lsof -t -i:PORT) substitution
  const killPortPattern = /^kill\s+(-9|-TERM|-KILL)\s+\$\(lsof\s+-t\s+-i:\d+\)$/i;
  if (killPortPattern.test(trimmed)) {
    return { allowed: true };
  }
  
  const parts = trimmed.split(/\s+/);
  const baseCommand = parts[0].toLowerCase();

  // Allow a very narrow, safe form of `source` for virtualenv activation only.
  if (baseCommand === "source") {
    const target = parts[1] || "";
    const allowedTargets = new Set([
      "venv/bin/activate",
      "./venv/bin/activate",
      ".venv/bin/activate",
      "./.venv/bin/activate",
    ]);
    if (!allowedTargets.has(target)) {
      return {
        allowed: false,
        reason:
          'Command "source" is only supported for virtualenv activation like `source venv/bin/activate` in this terminal',
      };
    }
    return { allowed: true };
  }

  // Handle venv/bin/... paths: extract the executable name and check if it's allowed
  const venvPathPatterns = [
    /^\.?\.?\/?venv\/bin\/(.+)$/i,
    /^\.?\.?\/?\.venv\/bin\/(.+)$/i,
  ];
  for (const pattern of venvPathPatterns) {
    const match = baseCommand.match(pattern);
    if (match) {
      const executable = match[1].toLowerCase();
      const isExecutableAllowed = ALLOWED_BASE_COMMANDS.some(
        (allowed) => executable === allowed.toLowerCase()
      );
      if (!isExecutableAllowed) {
        return {
          allowed: false,
          reason: `Command "${executable}" in virtualenv is not in the allowlist`,
        };
      }
      return { allowed: true };
    }
  }

  const isBaseAllowed = ALLOWED_BASE_COMMANDS.some(
    (allowed) => baseCommand === allowed.toLowerCase()
  );
  if (!isBaseAllowed) {
    return { allowed: false, reason: `Command "${baseCommand}" is not in the allowlist` };
  }
  return { allowed: true };
}

function getWorkspaceDir(workspaceId: string): string {
  const baseDir = process.env.WORKSPACE_BASE_DIR || join(tmpdir(), "workspaces");
  return resolve(baseDir, workspaceId);
}

async function syncWorkspaceToDisk(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string
): Promise<void> {
  const workspaceDir = getWorkspaceDir(workspaceId);
  const { data: files, error } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(`Failed to fetch workspace files: ${error.message}`);
  if (!files || files.length === 0) {
    await mkdir(workspaceDir, { recursive: true });
    return;
  }
  for (const file of files) {
    const filePath = join(workspaceDir, file.path);
    const fileDir = dirname(filePath);
    if (!existsSync(fileDir)) {
      await mkdir(fileDir, { recursive: true });
    }
    await writeFile(filePath, file.content || "", "utf-8");
  }
}

function doResolve(
  resolve: (r: { exitCode: number | null; stdout: string; stderr: string; errorMessage?: string; durationMs: number }) => void,
  result: { exitCode: number | null; stdout: string; stderr: string; errorMessage?: string; durationMs: number },
  resolved: { current: boolean }
) {
  if (resolved.current) return;
  resolved.current = true;
  resolve(result);
}

export async function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  activeVenv?: string,
  signal?: AbortSignal
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage?: string;
  durationMs: number;
}> {
  const startTime = Date.now();
  const resolved = { current: false };
  return new Promise((resolve) => {
    const trimmed = command.trim();

    // Check if this is a safe pipe chain or command substitution that needs shell execution
    const safePipePattern = /^lsof\s+-ti:\d+\s*\|\s*xargs\s+kill\s+(-9|-TERM|-KILL)?(\s*\|\|\s*true)?$/i;
    const killPortPattern = /^kill\s+(-9|-TERM|-KILL)\s+\$\(lsof\s+-t\s+-i:\d+\)$/i;
    const needsShell = safePipePattern.test(trimmed) || killPortPattern.test(trimmed);

    // For shell commands, execute directly with shell: true
    if (needsShell) {
      const child = spawn(trimmed, [], {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        doResolve(resolve, {
          exitCode: null,
          stdout,
          stderr,
          errorMessage: `Command timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - startTime,
        }, resolved);
      }, timeoutMs);

      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          child.kill("SIGTERM");
          doResolve(resolve, {
            exitCode: null,
            stdout,
            stderr,
            errorMessage: "Command cancelled (Ctrl+C)",
            durationMs: Date.now() - startTime,
          }, resolved);
        });
      }

      child.on("error", (error: Error & { code?: string }) => {
        clearTimeout(timeout);
        let errorMessage = `Failed to execute command: ${error.message}`;
        if (error.code === "ENOENT") {
          errorMessage = `Command not found. Make sure lsof, xargs, and kill are installed.`;
        }
        doResolve(resolve, {
          exitCode: null,
          stdout,
          stderr,
          errorMessage,
          durationMs: Date.now() - startTime,
        }, resolved);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        doResolve(resolve, {
          exitCode: code ?? null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs: Date.now() - startTime,
        }, resolved);
      });
      return;
    }
    
    // Non-shell command execution (existing logic)
    const parts = trimmed.split(/\s+/);
    let program: string = parts[0];
    const args = parts.slice(1);

    // If venv is active and command is pip/python/pip3/python3/pytest, use venv's binary
    if (activeVenv && !program.includes("/")) {
      const venvBinCommands = ["pip", "pip3", "python", "python3", "pytest"];
      if (venvBinCommands.includes(program.toLowerCase())) {
        const venvPath = join(cwd, activeVenv, "bin", program);
        if (existsSync(venvPath)) {
          program = venvPath;
        }
      }
    }

    // Handle venv/bin/... and .venv/bin/... paths
    const venvPathMatch = program.match(/^(\.?\.?\/?)(venv|\.venv)\/bin\/(.+)$/i);
    if (venvPathMatch) {
      const _prefix = venvPathMatch[1];
      const venvName = venvPathMatch[2];
      const executable = venvPathMatch[3];
      const venvPath = join(cwd, `${venvName}/bin/${executable}`);
      
      if (!existsSync(venvPath)) {
        const venvDir = join(cwd, venvName);
        if (!existsSync(venvDir)) {
          resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            errorMessage: `Virtual environment not found. Create it first with: python3 -m venv ${venvName}`,
            durationMs: Date.now() - startTime,
          });
          return;
        }
      }
      program = venvPath;
    }

    // Set up environment variables for venv if active
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    };
    
    if (activeVenv) {
      const venvPath = join(cwd, activeVenv);
      const venvBinPath = join(venvPath, "bin");
      if (existsSync(venvBinPath)) {
        // Prepend venv/bin to PATH so venv executables are found first
        env.PATH = `${venvBinPath}:${env.PATH}`;
        env.VIRTUAL_ENV = venvPath;
        // Remove PYTHONHOME if set, as it can interfere with venv
        delete env.PYTHONHOME;
      }
    }

    const child = spawn(program, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      doResolve(resolve, {
        exitCode: null,
        stdout,
        stderr,
        errorMessage: `Command timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - startTime,
      }, resolved);
    }, timeoutMs);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        child.kill("SIGTERM");
        doResolve(resolve, {
          exitCode: null,
          stdout,
          stderr,
          errorMessage: "Command cancelled (Ctrl+C)",
          durationMs: Date.now() - startTime,
        }, resolved);
      });
    }

    child.on("error", (error: Error & { code?: string }) => {
      clearTimeout(timeout);
      let errorMessage = `Failed to execute command: ${error.message}`;
      if (error.code === "ENOENT") {
        errorMessage = `Command "${program}" not found. Make sure it's installed and in your PATH.`;
      }
      doResolve(resolve, {
        exitCode: null,
        stdout,
        stderr,
        errorMessage,
        durationMs: Date.now() - startTime,
      }, resolved);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;
      const stderrLower = stderr.toLowerCase();
      if (
        code !== 0 &&
        (stderrLower.includes("externally-managed-environment") ||
          stderrLower.includes("pep 668") ||
          (stderrLower.includes("pip") && stderrLower.includes("system")))
      ) {
        doResolve(resolve, {
          exitCode: code ?? null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          errorMessage: `Python environment is externally managed. Use a virtual environment instead:\n1. Create venv: python3 -m venv venv\n2. Use venv's pip: venv/bin/pip install -r requirements.txt`,
          durationMs,
        }, resolved);
        return;
      }
      doResolve(resolve, {
        exitCode: code ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs,
      }, resolved);
    });
  });
}

/**
 * Execute a command in the workspace (server-side only).
 * Caller must ensure auth and workspace access.
 */
export async function executeCommandInWorkspace(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  command: string,
  abortSignal?: AbortSignal
): Promise<RunCommandResult> {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const baseCommand = parts[0].toLowerCase();

  // Handle `source venv/bin/activate` - activate venv for this workspace
  if (baseCommand === "source") {
    const target = parts[1] || "";
    const venvMatch = target.match(/^(\.?\.?\/?)(venv|\.venv)\/bin\/activate$/i);
    if (venvMatch) {
      const venvName = venvMatch[2];
      await syncWorkspaceToDisk(supabase, workspaceId);
      const workspaceDir = getWorkspaceDir(workspaceId);
      const venvPath = join(workspaceDir, venvName);
      const activatePath = join(venvPath, "bin", "activate");
      
      if (!existsSync(activatePath)) {
        return {
          ok: false,
          command,
          exitCode: null,
          stdout: "",
          stderr: "",
          errorMessage: `Virtual environment not found at ${venvName}. Create it first with: python3 -m venv ${venvName}`,
          durationMs: 0,
        };
      }
      
      // Store active venv for this workspace
      activeVenvs.set(workspaceId, venvName);
      
      return {
        ok: true,
        command,
        exitCode: 0,
        stdout: `Virtual environment '${venvName}' activated.\n` +
          "You can now use 'pip', 'python', etc. directly - they will use the virtualenv.",
        stderr: "",
        durationMs: 0,
      };
    }
  }

  // Handle `deactivate` - deactivate venv for this workspace
  if (baseCommand === "deactivate") {
    if (activeVenvs.has(workspaceId)) {
      activeVenvs.delete(workspaceId);
      return {
        ok: true,
        command,
        exitCode: 0,
        stdout: "Virtual environment deactivated.",
        stderr: "",
        durationMs: 0,
      };
    }
    return {
      ok: true,
      command,
      exitCode: 0,
      stdout: "No virtual environment was active.",
      stderr: "",
      durationMs: 0,
    };
  }

  const { allowed, reason } = isCommandAllowed(command);
  if (!allowed) {
    return {
      ok: false,
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      errorMessage: `Command blocked: ${reason}`,
      durationMs: 0,
    };
  }
  
  try {
    await syncWorkspaceToDisk(supabase, workspaceId);
    const workspaceDir = getWorkspaceDir(workspaceId);
    const activeVenv = activeVenvs.get(workspaceId);
    const perToolTimeout = getToolTimeoutMs("run_command");
    const timeout = isServerCommand(command) ? SERVER_COMMAND_TIMEOUT_MS : perToolTimeout;
    const result = await executeCommand(command, workspaceDir, timeout, activeVenv, abortSignal);
    const ok = result.exitCode === 0 && !result.errorMessage;
    logToolExecution({
      toolName: "run_command",
      workspaceId,
      durationMs: result.durationMs,
      success: ok,
      command,
    });
    return {
      ok,
      command,
      ...result,
    };
  } catch (error) {
    return {
      ok: false,
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      errorMessage: error instanceof Error ? error.message : "Internal error",
      durationMs: 0,
    };
  }
}
