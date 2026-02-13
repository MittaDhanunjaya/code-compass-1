/**
 * Deterministic Error Recovery Layer: rule-based fixes for common terminal errors.
 * Escalate to LLM only when no rule matches.
 */

import { findAvailablePort, extractPortFromError } from "./port-utils";

export type ErrorRecoveryResult =
  | { fixed: true; command: string; reason: string; retry: boolean }
  | { fixed: false; escalateToLlm: boolean };

/** Match EADDRINUSE / port in use. */
function isEaddrInUse(stderr: string, stdout: string): boolean {
  const combined = (stderr + stdout).toLowerCase();
  return (
    combined.includes("eaddrinuse") ||
    combined.includes("address already in use") ||
    combined.includes("port") && combined.includes("already in use")
  );
}

/** Match missing npm script. */
function isMissingNpmScript(stderr: string, stdout: string): boolean {
  const combined = (stderr + stdout).toLowerCase();
  return (
    combined.includes("missing script") ||
    combined.includes("npm err!") && combined.includes("script") ||
    /script.*not found|unknown script/i.test(combined)
  );
}

/** Match missing module / package (Node or Python). */
function isMissingModule(stderr: string, stdout: string): boolean {
  const combined = (stderr + stdout).toLowerCase();
  return (
    combined.includes("cannot find module") ||
    combined.includes("module not found") ||
    (combined.includes("no such file or directory") && combined.includes("node_modules")) ||
    combined.includes("modulenotfounderror") ||
    (combined.includes("import") && combined.includes("error")) ||
    combined.includes("no module named")
  );
}

/** Likely a Python import error (vs Node). */
function isPythonImportError(stderr: string, stdout: string): boolean {
  const combined = (stderr + stdout).toLowerCase();
  return (
    combined.includes("no module named") ||
    (combined.includes("modulenotfounderror") && combined.includes("import"))
  );
}

/** Match permission denied. */
function isPermissionDenied(stderr: string, stdout: string): boolean {
  const combined = (stderr + stdout).toLowerCase();
  return (
    combined.includes("eacces") ||
    combined.includes("permission denied") ||
    combined.includes("permission denied")
  );
}

/** Match port already allocated. */
function isPortAllocated(stderr: string, stdout: string): boolean {
  return isEaddrInUse(stderr, stdout);
}

/**
 * Check if error can be auto-fixed by rules. Returns fix suggestion or escalate.
 */
export async function tryErrorRecovery(
  command: string,
  stderr: string,
  stdout: string
): Promise<ErrorRecoveryResult> {
  // EADDRINUSE / port in use → change port
  if (isEaddrInUse(stderr, stdout)) {
    const port = extractPortFromError(stderr + stdout);
    if (port != null) {
      const freePort = await findAvailablePort(port + 1, 10);
      if (freePort != null) {
        const newCommand = command.replace(/:\d+|\d+\s/g, (m) => {
          const num = parseInt(m.replace(/\D/g, ""), 10);
          return num === port ? String(freePort) : m;
        });
        if (newCommand !== command) {
          return { fixed: true, command: newCommand, reason: `Port ${port} in use, switched to ${freePort}`, retry: true };
        }
        // Try PORT= env
        return { fixed: true, command: `PORT=${freePort} ${command}`, reason: `Port ${port} in use, using PORT=${freePort}`, retry: true };
      }
    }
  }

  // Missing npm script "dev" → try "npm start" instead (common for Node apps)
  if (isMissingNpmScript(stderr, stdout)) {
    if (/npm run dev|npm run\s+dev/i.test(command)) {
      return { fixed: true, command: "npm start", reason: "No 'dev' script; trying 'npm start' instead.", retry: true };
    }
    return { fixed: false, escalateToLlm: true };
  }

  // Missing modules → npm install (Node) or pip install -r requirements.txt (Python)
  if (isMissingModule(stderr, stdout)) {
    if (isPythonImportError(stderr, stdout)) {
      return {
        fixed: true,
        command: "pip install -r requirements.txt",
        reason: "Missing Python module detected. Running pip install -r requirements.txt.",
        retry: true,
      };
    }
    return {
      fixed: true,
      command: "npm install",
      reason: "Missing module detected. Running npm install.",
      retry: true,
    };
  }

  // Permission denied → chmod (we can't safely chmod; escalate)
  if (isPermissionDenied(stderr, stdout)) {
    return { fixed: false, escalateToLlm: true };
  }

  // Port already allocated → auto-scan free port (handled above)
  if (isPortAllocated(stderr, stdout)) {
    const port = extractPortFromError(stderr + stdout);
    if (port != null) {
      const freePort = await findAvailablePort(port + 1, 10);
      if (freePort != null) {
        return { fixed: true, command: `PORT=${freePort} ${command}`, reason: `Port ${port} in use, using PORT=${freePort}`, retry: true };
      }
    }
  }

  return { fixed: false, escalateToLlm: true };
}

/**
 * Check if a fix is a simple retry (e.g. npm install) - caller can run it.
 */
export function isRetryableFix(result: ErrorRecoveryResult): result is { fixed: true; command: string; reason: string; retry: true } {
  return result.fixed && result.retry;
}
