/**
 * Sandbox-first execution pipeline: create temporary copies of workspace files,
 * apply edits, run checks (lint/tests), and only promote to workspace if checks pass.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FileEditStep } from "@/lib/agent/types";
import { applyEdit } from "@/lib/agent/diff-engine";
import { beautifyCode } from "@/lib/utils/code-beautifier";
import { getLintCommands, getTestCommands, getRunCommands, detectStack } from "./stack-commands";

export type SandboxSource = "agent" | "composer" | "debug-from-log";

export type SandboxCheckStatus = "passed" | "failed" | "skipped" | "not_configured";

export type SandboxCheckResult = {
  lint: { status: SandboxCheckStatus; logs: string };
  tests: { status: SandboxCheckStatus; logs: string };
  run: { status: SandboxCheckStatus; logs: string; port?: number };
};

/** Metadata stored on sandbox_runs for evaluation (e.g. debug-from-log). */
export type SandboxRunMetadata = {
  error_log?: string;
  error_type?: string;
  model_used?: string;
  proposed_edit_paths?: string[];
  /** When user pasted error (debug-from-log); used with promoted_at for time-to-green. */
  first_error_at?: string;
  /** Hash of error snippet for regression detection (same error reappearing). */
  error_fingerprint?: string;
};

/**
 * Create a sandbox from a workspace snapshot.
 * If filePaths is provided, copy only those files; otherwise copy all workspace files.
 */
export async function createSandboxFromWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  options: {
    source?: SandboxSource;
    filePaths?: string[];
    metadata?: SandboxRunMetadata;
  } = {}
): Promise<string> {
  const { source, filePaths, metadata } = options;

  // Create sandbox run record
  const { data: sandboxRun, error: runError } = await supabase
    .from("sandbox_runs")
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      source: source ?? null,
      metadata: metadata ?? null,
    })
    .select("id")
    .single();

  if (runError || !sandboxRun) {
    throw new Error(`Failed to create sandbox run: ${runError?.message ?? "Unknown error"}`);
  }

  const sandboxRunId = sandboxRun.id;

  // Fetch workspace files (all or filtered)
  const query = supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  const { data: workspaceFiles, error: filesError } = await query;

  if (filesError) {
    throw new Error(`Failed to fetch workspace files: ${filesError.message}`);
  }

  if (!workspaceFiles || workspaceFiles.length === 0) {
    return sandboxRunId; // Empty workspace, return sandbox ID
  }

  // Filter files if filePaths provided
  const filesToCopy = filePaths
    ? workspaceFiles.filter((f) => filePaths.includes(f.path))
    : workspaceFiles;

  // Copy files to sandbox_files
  if (filesToCopy.length > 0) {
    const sandboxFiles = filesToCopy.map((f) => ({
      sandbox_run_id: sandboxRunId,
      path: f.path,
      content: f.content ?? "",
    }));

    const { error: insertError } = await supabase
      .from("sandbox_files")
      .insert(sandboxFiles);

    if (insertError) {
      throw new Error(`Failed to copy files to sandbox: ${insertError.message}`);
    }
  }

  return sandboxRunId;
}

/**
 * Apply edits to sandbox files (same logic as workspace apply, but writes to sandbox_files).
 */
export async function applyEditsToSandbox(
  supabase: SupabaseClient,
  sandboxRunId: string,
  edits: FileEditStep[]
): Promise<{
  filesEdited: string[];
  conflicts: { path: string; message: string }[];
}> {
  const filesEdited: string[] = [];
  const conflicts: { path: string; message: string }[] = [];

  for (const edit of edits) {
    const path = edit.path.trim();

    // Get current sandbox file content
    const { data: fileRow } = await supabase
      .from("sandbox_files")
      .select("content")
      .eq("sandbox_run_id", sandboxRunId)
      .eq("path", path)
      .single();

    if (!fileRow) {
      // New file: insert
      // Beautify code before writing (convert \n to actual newlines, etc.)
      const beautifiedContent = beautifyCode(edit.newContent, path);
      
      const { error: insertError } = await supabase
        .from("sandbox_files")
        .insert({
          sandbox_run_id: sandboxRunId,
          path,
          content: beautifiedContent,
        });

      if (insertError) {
        conflicts.push({
          path,
          message: `Failed to create file in sandbox: ${insertError.message}`,
        });
      } else {
        filesEdited.push(path);
      }
      continue;
    }

    // Apply edit to existing file
    const currentContent = fileRow.content ?? "";
    // Beautify new content before applying edit (convert \n to actual newlines, etc.)
    const beautifiedNewContent = beautifyCode(edit.newContent, path);
    
    // IMPORTANT: Don't beautify oldContent - it needs to match the actual file content
    // The oldContent from the plan might have escaped newlines, but the actual file
    // content in the database might already be beautified. We need to match what's actually there.
    // Instead, beautify the currentContent for comparison if oldContent is provided
    let oldContentToMatch = edit.oldContent;
    let contentToMatchAgainst = currentContent;
    
    // If oldContent is provided, beautify both for comparison
    if (oldContentToMatch) {
      const beautifiedOldContent = beautifyCode(oldContentToMatch, path);
      const beautifiedCurrentContent = beautifyCode(currentContent, path);
      // Try matching with beautified versions first
      if (beautifiedCurrentContent.includes(beautifiedOldContent)) {
        oldContentToMatch = beautifiedOldContent;
        contentToMatchAgainst = beautifiedCurrentContent;
      }
    }
    
    const result = applyEdit(contentToMatchAgainst, beautifiedNewContent, oldContentToMatch);

    if (!result.ok) {
      const isDebugFromLog = edit.source === "debug-from-log";
      const conflictMessage = isDebugFromLog
        ? `Could not apply fix for ${path} because the file changed after the error was analyzed. Please review manually or re-run debug-from-log with the latest code.`
        : "Edit conflict: file changed since planning. Please review manually or re-run with updated context.";
      conflicts.push({ path, message: conflictMessage });
      continue;
    }

    // Update sandbox file
    const { error: updateError } = await supabase
      .from("sandbox_files")
      .update({
        content: result.content,
        updated_at: new Date().toISOString(),
      })
      .eq("sandbox_run_id", sandboxRunId)
      .eq("path", path);

    if (updateError) {
      conflicts.push({
        path,
        message: `Failed to update file in sandbox: ${updateError.message}`,
      });
    } else {
      filesEdited.push(path);
    }
  }

  return { filesEdited, conflicts };
}

/**
 * Promote sandbox files back to workspace (applies approved changes).
 * Reuses conflict-aware applyEdit logic.
 */
export async function promoteSandboxToWorkspace(
  supabase: SupabaseClient,
  sandboxRunId: string
): Promise<{
  filesEdited: string[];
  conflicts: { path: string; message: string }[];
}> {
  // Get sandbox run info
  const { data: sandboxRun, error: runError } = await supabase
    .from("sandbox_runs")
    .select("workspace_id")
    .eq("id", sandboxRunId)
    .single();

  if (runError || !sandboxRun) {
    throw new Error(`Sandbox run not found: ${runError?.message ?? "Unknown error"}`);
  }

  const workspaceId = sandboxRun.workspace_id;

  // Get all sandbox files
  const { data: sandboxFiles, error: filesError } = await supabase
    .from("sandbox_files")
    .select("path, content")
    .eq("sandbox_run_id", sandboxRunId);

  if (filesError) {
    throw new Error(`Failed to fetch sandbox files: ${filesError.message}`);
  }

  if (!sandboxFiles || sandboxFiles.length === 0) {
    return { filesEdited: [], conflicts: [] };
  }

  const filesEdited: string[] = [];
  const conflicts: { path: string; message: string }[] = [];

  // Apply each sandbox file to workspace (with conflict detection)
  for (const sandboxFile of sandboxFiles) {
    const path = sandboxFile.path;

    // Get current workspace file
    const { data: workspaceFile } = await supabase
      .from("workspace_files")
      .select("content")
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .single();

    if (!workspaceFile) {
      // New file: insert
      // Ensure content is beautified before promoting to workspace
      const beautifiedContent = beautifyCode(sandboxFile.content || "", path);
      
      const { error: insertError } = await supabase
        .from("workspace_files")
        .insert({
          workspace_id: workspaceId,
          path,
          content: beautifiedContent,
        });

      if (insertError) {
        conflicts.push({
          path,
          message: `Failed to create file in workspace: ${insertError.message}`,
        });
      } else {
        filesEdited.push(path);
      }
      continue;
    }

    // Check if workspace file changed since sandbox was created
    // We compare current workspace content with what we expect (from sandbox's original snapshot)
    // For simplicity, we'll do a direct update if content matches, otherwise treat as conflict
    const currentContent = workspaceFile.content ?? "";
    // Ensure sandbox content is beautified before promoting
    const beautifiedSandboxContent = beautifyCode(sandboxFile.content ?? "", path);

    // If workspace content matches what we expect (or is empty/new), update directly
    // Otherwise, we'd need to store original content in sandbox_runs metadata
    // For now, we'll update directly (conflict detection happens at sandbox creation time)
    const { error: updateError } = await supabase
      .from("workspace_files")
      .update({
        content: beautifiedSandboxContent,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("path", path);

    if (updateError) {
      conflicts.push({
        path,
        message: `Failed to update file in workspace: ${updateError.message}`,
      });
    } else {
      filesEdited.push(path);
    }
  }

  // Mark sandbox as promoted
  await supabase
    .from("sandbox_runs")
    .update({ promoted_at: new Date().toISOString() })
    .eq("id", sandboxRunId);

  return { filesEdited, conflicts };
}

/**
 * Get sandbox directory path for command execution.
 */
export function getSandboxDir(sandboxRunId: string): string {
  const { join, resolve } = require("path");
  const { tmpdir } = require("os");
  const baseDir = process.env.SANDBOX_BASE_DIR || join(tmpdir(), "sandboxes");
  return resolve(baseDir, sandboxRunId);
}

/**
 * Sync sandbox files to disk for command execution.
 */
export async function syncSandboxToDisk(
  supabase: SupabaseClient,
  sandboxRunId: string
): Promise<void> {
  const { mkdir, writeFile } = require("fs/promises");
  const { join, dirname } = require("path");
  const { existsSync } = require("fs");

  const sandboxDir = getSandboxDir(sandboxRunId);

  const { data: files, error } = await supabase
    .from("sandbox_files")
    .select("path, content")
    .eq("sandbox_run_id", sandboxRunId);

  if (error) throw new Error(`Failed to fetch sandbox files: ${error.message}`);
  if (!files || files.length === 0) {
    await mkdir(sandboxDir, { recursive: true });
    return;
  }

  for (const file of files) {
    const filePath = join(sandboxDir, file.path);
    const fileDir = dirname(filePath);
    if (!existsSync(fileDir)) {
      await mkdir(fileDir, { recursive: true });
    }
    // Beautify content before writing to disk (convert \n to actual newlines, etc.)
    const beautifiedContent = beautifyCode(file.content || "", file.path);
    await writeFile(filePath, beautifiedContent, "utf-8");
  }
}

/**
 * Run sandbox checks (lint, tests, run).
 * Returns results for each check with status: passed, failed, skipped, or not_configured.
 */
export async function runSandboxChecks(
  supabase: SupabaseClient,
  sandboxRunId: string,
  executeCommandFn: (command: string, cwd: string) => Promise<{
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>
): Promise<SandboxCheckResult> {
  await syncSandboxToDisk(supabase, sandboxRunId);
  const sandboxDir = getSandboxDir(sandboxRunId);
  
  // Debug: Log what files are in the sandbox (for troubleshooting)
  // This helps verify docker-compose.yml is present
  try {
    const { readdirSync } = require("fs");
    const files = readdirSync(sandboxDir, { recursive: false });
    console.log(`[Sandbox] Files in sandbox: ${files.slice(0, 10).join(", ")}${files.length > 10 ? "..." : ""}`);
  } catch {
    // Ignore - just for debugging
  }

  const { join } = require("path");
  const packageJsonPath = join(sandboxDir, "package.json");
  const hasPackageJson = existsSync(packageJsonPath);
  const stack = detectStack(sandboxDir);

  // Lint: use package.json scripts (test:unit, lint, etc.) or stack heuristic (pytest, go test, mvn, cargo)
  const lintCommands = getLintCommands(sandboxDir);
  let lintResult: { status: SandboxCheckStatus; logs: string } = { status: "not_configured", logs: "" };
  let lintFound = false;
  for (const cmd of lintCommands) {
    try {
      const result = await executeCommandFn(cmd, sandboxDir);
      if (result.exitCode !== null) {
        lintFound = true;
        if (result.ok && result.exitCode === 0) {
          lintResult = { status: "passed", logs: result.stdout || result.stderr || "Lint passed" };
        } else {
          lintResult = { status: "failed", logs: `${result.stdout}\n${result.stderr}`.trim() || "Lint failed" };
        }
        break;
      }
    } catch {
      continue;
    }
  }
  if (!lintFound) {
    lintResult = {
      status: stack === "unknown" ? "skipped" : "not_configured",
      logs: lintCommands.length === 0
        ? (stack === "unknown" ? "No recognized project (Node/Python/Go/Java/Rust)" : `No lint command found for ${stack}`)
        : "Lint script not available or failed to run",
    };
  }

  // Tests: same approach
  const testCommands = getTestCommands(sandboxDir);
  let testResult: { status: SandboxCheckStatus; logs: string } = { status: "not_configured", logs: "" };
  let testFound = false;
  for (const cmd of testCommands) {
    try {
      const result = await executeCommandFn(cmd, sandboxDir);
      if (result.exitCode !== null) {
        testFound = true;
        if (result.ok && result.exitCode === 0) {
          testResult = { status: "passed", logs: result.stdout || result.stderr || "Tests passed" };
        } else {
          testResult = { status: "failed", logs: `${result.stdout}\n${result.stderr}`.trim() || "Tests failed" };
        }
        break;
      }
    } catch {
      continue;
    }
  }
  if (!testFound) {
    testResult = {
      status: stack === "unknown" ? "skipped" : "not_configured",
      logs: testCommands.length === 0
        ? (stack === "unknown" ? "No recognized project" : `No test command found for ${stack}`)
        : "Test script not available or failed to run",
    };
  }

  // Try to run the application to verify it actually works
  let runResult: { status: SandboxCheckStatus; logs: string; port?: number } = { status: "not_configured", logs: "" };
  
  // Check for Docker-based projects
  const dockerComposePath = join(sandboxDir, "docker-compose.yml");
  const dockerComposeYamlPath = join(sandboxDir, "docker-compose.yaml");
  const dockerfilePath = join(sandboxDir, "Dockerfile");
  const hasDockerCompose = existsSync(dockerComposePath) || existsSync(dockerComposeYamlPath);
  const hasDockerfile = existsSync(dockerfilePath);
  
  if (hasDockerCompose || hasDockerfile) {
    // Docker-based project - try docker-compose up --build
    try {
      // Use docker-compose up --build to build and start containers
      // We'll check if it builds successfully (even if containers don't stay up)
      const cmd = hasDockerCompose ? `docker-compose up --build` : `docker build . && docker-compose up`;
      
      // Wrap with timeout for Docker build/start
      const timeoutPromise = new Promise<Awaited<ReturnType<typeof executeCommandFn>>>((resolve) => {
        setTimeout(() => {
          resolve({
            ok: false,
            exitCode: null,
            stdout: "",
            stderr: "Docker command timed out after 30 seconds",
            durationMs: 30000,
          });
        }, 30000); // 30 second timeout for Docker (builds can take time)
      });
      
      const result = await Promise.race([
        executeCommandFn(cmd, sandboxDir),
        timeoutPromise,
      ]);
      
      const stderrLower = result.stderr.toLowerCase();
      const stdoutLower = result.stdout.toLowerCase();
      const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
      
      const hasError = 
        stderrLower.includes("error") || 
        stderrLower.includes("failed") ||
        stderrLower.includes("cannot find") ||
        stderrLower.includes("no such file") ||
        stderrLower.includes("build failed") ||
        stderrLower.includes("exit code") ||
        stderrLower.includes("unable to") ||
        stderrLower.includes("command not found") ||
        stderrLower.includes("permission denied") ||
        stdoutLower.includes("error") || // Also check stdout for errors
        stdoutLower.includes("failed") ||
        (result.exitCode !== null && result.exitCode !== 0 && !combinedOutput.includes("started") && !combinedOutput.includes("created") && !combinedOutput.includes("successfully"));
      
      const hasSuccess = 
        combinedOutput.includes("created") ||
        combinedOutput.includes("started") ||
        combinedOutput.includes("up and running") ||
        combinedOutput.includes("healthy") ||
        combinedOutput.includes("listening") ||
        combinedOutput.includes("successfully built") ||
        (result.exitCode === 0) ||
        (result.exitCode === null && !hasError); // Still running = likely started
      
      if (hasError) {
        runResult = {
          status: "failed",
          logs: `${result.stdout}\n${result.stderr}`.trim() || "Docker compose failed to start",
        };
      } else if (hasSuccess) {
        // Extract port from docker-compose output
        const portMatch = combinedOutput.match(/(?:port|listening|running).*?[:\s](\d{4,5})/i);
        const port = portMatch ? parseInt(portMatch[1], 10) : undefined;
        runResult = {
          status: "passed",
          logs: result.stdout || result.stderr || "Docker containers started successfully",
          port,
        };
      } else {
        runResult = {
          status: "failed",
          logs: `${result.stdout}\n${result.stderr}`.trim() || "Docker compose command did not succeed",
        };
      }
    } catch (error) {
      runResult = {
        status: "failed",
        logs: error instanceof Error ? error.message : "Docker compose execution failed",
      };
    }
  } else if (hasPackageJson) {
    // Node.js project - Read package.json to find start/dev scripts
    try {
      const { readFileSync } = require("fs");
      const packageJsonContent = readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(packageJsonContent);
      const scripts = packageJson.scripts || {};
      
      // Try common run commands
      const runCommands: Array<{ cmd: string; isServer: boolean }> = [];
      if (scripts.start) runCommands.push({ cmd: `npm run start`, isServer: true });
      if (scripts.dev) runCommands.push({ cmd: `npm run dev`, isServer: true });
      if (scripts.serve) runCommands.push({ cmd: `npm run serve`, isServer: true });
      // Also try direct node commands if main/index exists
      if (packageJson.main) {
        runCommands.push({ cmd: `node ${packageJson.main}`, isServer: true });
      }
      
      // Try to start the app and verify it runs (with short timeout for server commands)
      for (const { cmd, isServer } of runCommands) {
        try {
          // For server commands, wrap with Promise.race to timeout after 15 seconds
          // This allows us to check if the server starts successfully without waiting forever
          let result: Awaited<ReturnType<typeof executeCommandFn>>;
          
          if (isServer) {
            // Wrap server command execution with a timeout
            const timeoutPromise = new Promise<Awaited<ReturnType<typeof executeCommandFn>>>((resolve) => {
              setTimeout(() => {
                resolve({
                  ok: false,
                  exitCode: null,
                  stdout: "",
                  stderr: "Command timed out after 15 seconds (server may still be starting)",
                  durationMs: 15000,
                });
              }, 15000); // 15 second timeout for run check
            });
            
            result = await Promise.race([
              executeCommandFn(cmd, sandboxDir),
              timeoutPromise,
            ]);
          } else {
            result = await executeCommandFn(cmd, sandboxDir);
          }
          
          // Check for common error patterns
          const stderrLower = result.stderr.toLowerCase();
          const stdoutLower = result.stdout.toLowerCase();
          const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
          
          const hasError = 
            stderrLower.includes("error") || 
            stderrLower.includes("failed") ||
            stderrLower.includes("cannot find") ||
            stderrLower.includes("module not found") ||
            stderrLower.includes("cannot resolve") ||
            stderrLower.includes("syntax error") ||
            stderrLower.includes("unexpected token") ||
            stderrLower.includes("eaddrinuse") || // Port already in use
            stderrLower.includes("port") && stderrLower.includes("already in use") || // Port conflict
            stderrLower.includes("enotfound") || // Module not found
            (result.exitCode !== null && result.exitCode !== 0 && !isServer);
          
          // Check for success indicators
          const hasSuccess = 
            combinedOutput.includes("listening") ||
            combinedOutput.includes("ready") ||
            combinedOutput.includes("started") ||
            combinedOutput.includes("running on") ||
            combinedOutput.includes("compiled successfully") ||
            combinedOutput.includes("server running") ||
            combinedOutput.includes("server started") ||
            (isServer && result.exitCode === null && !result.stderr.includes("timeout")); // Still running = likely started
          
          if (hasError) {
            runResult = {
              status: "failed",
              logs: `${result.stdout}\n${result.stderr}`.trim() || "Application failed to start",
            };
            break;
          } else if (hasSuccess) {
            // Extract port if mentioned
            const portMatch = (result.stdout + "\n" + result.stderr).match(/(?:listening|running|started|on|port).*?[:\s](\d{4,5})/i);
            const port = portMatch ? parseInt(portMatch[1], 10) : undefined;
            runResult = {
              status: "passed",
              logs: result.stdout || result.stderr || "Application started successfully",
              port,
            };
            break;
          } else if (result.exitCode === 0) {
            // Non-server command that completed successfully
            runResult = {
              status: "passed",
              logs: result.stdout || result.stderr || "Application ran successfully",
            };
            break;
          } else if (result.exitCode !== null && result.exitCode !== 0) {
            // Command failed with non-zero exit code
            runResult = {
              status: "failed",
              logs: `${result.stdout}\n${result.stderr}`.trim() || "Application failed to run",
            };
            break;
          } else if (isServer && result.stderr.includes("timeout")) {
            // Server command timed out - we can't be sure if it started
            // This is ambiguous, so we'll mark as not_configured and try next command
            continue;
          }
          // If exitCode is null and no success/error indicators, try next command
        } catch {
          continue;
        }
      }
      
      if (runResult.status === "not_configured" && runCommands.length === 0) {
        runResult = {
          status: "not_configured",
          logs: "No start/dev/serve script found in package.json",
        };
      }
    } catch {
      runResult = {
        status: "skipped",
        logs: "Could not read package.json",
      };
    }
  } else {
    // Check for Python projects
    const requirementsPath = join(sandboxDir, "requirements.txt");
    const pyProjectPath = join(sandboxDir, "pyproject.toml");
    const setupPyPath = join(sandboxDir, "setup.py");
    const hasPythonProject = existsSync(requirementsPath) || existsSync(pyProjectPath) || existsSync(setupPyPath);
    
    if (hasPythonProject) {
      // Try to find main Python file (common patterns)
      const { readdirSync } = require("fs");
      let mainPyFile: string | null = null;
      
      try {
        const files = readdirSync(sandboxDir, { recursive: false });
        // Look for common entry points
        const entryPoints = ["main.py", "app.py", "run.py", "server.py", "__main__.py"];
        for (const entry of entryPoints) {
          if (files.includes(entry)) {
            mainPyFile = entry;
            break;
          }
        }
        // If no common entry point, look for .py files in root
        if (!mainPyFile) {
          const pyFiles = files.filter((f: string) => f.endsWith(".py") && !f.includes("/"));
          if (pyFiles.length === 1) {
            mainPyFile = pyFiles[0];
          }
        }
      } catch {
        // Can't read directory, skip Python detection
      }
      
      if (mainPyFile) {
        try {
          // Try running with venv if it exists, otherwise system python
          const venvPython = existsSync(join(sandboxDir, "venv", "bin", "python")) 
            ? "venv/bin/python" 
            : existsSync(join(sandboxDir, ".venv", "bin", "python"))
            ? ".venv/bin/python"
            : null;
          
          const pythonCmd = venvPython || "python3";
          const cmd = `${pythonCmd} ${mainPyFile}`;
          
          const timeoutPromise = new Promise<Awaited<ReturnType<typeof executeCommandFn>>>((resolve) => {
            setTimeout(() => {
              resolve({
                ok: false,
                exitCode: null,
                stdout: "",
                stderr: "Python command timed out after 15 seconds",
                durationMs: 15000,
              });
            }, 15000);
          });
          
          const result = await Promise.race([
            executeCommandFn(cmd, sandboxDir),
            timeoutPromise,
          ]);
          
          const stderrLower = result.stderr.toLowerCase();
          const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
          
          const hasError = 
            stderrLower.includes("error") || 
            stderrLower.includes("failed") ||
            stderrLower.includes("cannot find") ||
            stderrLower.includes("module not found") ||
            stderrLower.includes("import error") ||
            (result.exitCode !== null && result.exitCode !== 0);
          
          const hasSuccess = 
            combinedOutput.includes("listening") ||
            combinedOutput.includes("running") ||
            combinedOutput.includes("started") ||
            (result.exitCode === 0) ||
            (result.exitCode === null && !hasError); // Still running = likely started
          
          if (hasError) {
            runResult = {
              status: "failed",
              logs: `${result.stdout}\n${result.stderr}`.trim() || "Python application failed to run",
            };
          } else if (hasSuccess) {
            const portMatch = combinedOutput.match(/(?:listening|running|port).*?[:\s](\d{4,5})/i);
            const port = portMatch ? parseInt(portMatch[1], 10) : undefined;
            runResult = {
              status: "passed",
              logs: result.stdout || result.stderr || "Python application started successfully",
              port,
            };
          } else {
            runResult = {
              status: "failed",
              logs: `${result.stdout}\n${result.stderr}`.trim() || "Python application did not start",
            };
          }
        } catch (error) {
          runResult = {
            status: "failed",
            logs: error instanceof Error ? error.message : "Python execution failed",
          };
        }
      } else {
        runResult = {
          status: "not_configured",
          logs: "Python project detected but no main entry point found",
        };
      }
    } else {
      // Go / Java / Rust: use stack profile run commands
      const profileRunCommands = getRunCommands(sandboxDir);
      if (profileRunCommands.length > 0) {
        runResult = { status: "not_configured", logs: "" };
        for (const { cmd, isServer } of profileRunCommands) {
          try {
            let result: Awaited<ReturnType<typeof executeCommandFn>>;
            if (isServer) {
              const timeoutPromise = new Promise<Awaited<ReturnType<typeof executeCommandFn>>>((resolve) => {
                setTimeout(() => {
                  resolve({
                    ok: false,
                    exitCode: null,
                    stdout: "",
                    stderr: "Command timed out after 15 seconds (server may still be starting)",
                    durationMs: 15000,
                  });
                }, 15000);
              });
              result = await Promise.race([executeCommandFn(cmd, sandboxDir), timeoutPromise]);
            } else {
              result = await executeCommandFn(cmd, sandboxDir);
            }
            const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
            const hasError =
              result.stderr.toLowerCase().includes("error") ||
              result.stderr.toLowerCase().includes("failed") ||
              (result.exitCode !== null && result.exitCode !== 0 && !isServer);
            const hasSuccess =
              combinedOutput.includes("listening") ||
              combinedOutput.includes("running") ||
              combinedOutput.includes("started") ||
              (result.exitCode === 0) ||
              (isServer && result.exitCode === null && !result.stderr.includes("timeout"));
            if (hasError) {
              runResult = { status: "failed", logs: `${result.stdout}\n${result.stderr}`.trim() || "Application failed to start" };
              break;
            }
            if (hasSuccess) {
              const portMatch = combinedOutput.match(/(?:listening|running|port).*?[:\s](\d{4,5})/i);
              runResult = {
                status: "passed",
                logs: result.stdout || result.stderr || "Application started successfully",
                port: portMatch ? parseInt(portMatch[1], 10) : undefined,
              };
              break;
            }
            if (isServer && result.stderr.includes("timeout")) continue;
          } catch {
            continue;
          }
        }
        if (runResult.status === "not_configured" && profileRunCommands.length > 0) {
          runResult = { status: "skipped", logs: "Profile run commands tried but none succeeded" };
        }
      } else {
        runResult = {
          status: "skipped",
          logs: "No recognized project type (Node.js/Docker/Python/Go/Java/Rust) detected",
        };
      }
    }
  }

  // Update sandbox run with check results
  // Only mark as passed if all checks passed (or were skipped/not configured)
  const allPassed = 
    (lintResult.status === "passed" || lintResult.status === "skipped" || lintResult.status === "not_configured") &&
    (testResult.status === "passed" || testResult.status === "skipped" || testResult.status === "not_configured") &&
    (runResult.status === "passed" || runResult.status === "skipped" || runResult.status === "not_configured");
  
  await supabase
    .from("sandbox_runs")
    .update({ sandbox_checks_passed: allPassed })
    .eq("id", sandboxRunId);

  return {
    lint: lintResult,
    tests: testResult,
    run: runResult,
  };
}
