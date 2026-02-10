/**
 * Client-safe types and constants for Code Compass stack config.
 * No Node APIs (fs, path) - safe to import from client components.
 * For fs-based loading, use code-compass-config.ts (server-only).
 */

export const CODE_COMPASS_CONFIG_PATH = ".code-compass/config.json";

export type CodeCompassStack =
  | "nextjs"
  | "node"
  | "python"
  | "go"
  | "java"
  | "rust"
  | "dotnet";

export type CodeCompassServiceConfig = {
  name: string;
  root: string;
  stack: CodeCompassStack;
  lintCommand?: string;
  testCommand?: string;
  runCommand?: string;
};

export type CodeCompassConfig = {
  services: CodeCompassServiceConfig[];
};

const ALLOWED_STACKS: CodeCompassStack[] = [
  "nextjs",
  "node",
  "python",
  "go",
  "java",
  "rust",
  "dotnet",
];

function isCodeCompassStack(s: unknown): s is CodeCompassStack {
  return typeof s === "string" && ALLOWED_STACKS.includes(s as CodeCompassStack);
}

/**
 * Validate a parsed config object. Returns either a typed config or a list of errors.
 */
export function validateCodeCompassConfig(config: unknown):
  | { ok: true; value: CodeCompassConfig }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (config == null || typeof config !== "object") {
    return { ok: false, errors: ["Config must be an object"] };
  }

  const raw = config as Record<string, unknown>;
  if (!Array.isArray(raw.services)) {
    return { ok: false, errors: ["services must be an array"] };
  }

  if (raw.services.length === 0) {
    errors.push("services must be a non-empty array");
  }

  const services: CodeCompassServiceConfig[] = [];

  raw.services.forEach((s, i) => {
    if (s == null || typeof s !== "object") {
      errors.push(`services[${i}] must be an object`);
      return;
    }
    const svc = s as Record<string, unknown>;
    const name = typeof svc.name === "string" ? svc.name.trim() : "";
    const root = typeof svc.root === "string" ? svc.root.trim() : "";
    const stack = svc.stack;

    if (!name) errors.push(`services[${i}].name must be a non-empty string`);
    if (!root) errors.push(`services[${i}].root must be a non-empty string`);
    if (!isCodeCompassStack(stack)) {
      errors.push(
        `services[${i}].stack must be one of: ${ALLOWED_STACKS.join(", ")}`
      );
    }

    const lintCommand =
      svc.lintCommand !== undefined
        ? typeof svc.lintCommand === "string"
          ? svc.lintCommand.trim()
          : ""
        : undefined;
    const testCommand =
      svc.testCommand !== undefined
        ? typeof svc.testCommand === "string"
          ? svc.testCommand.trim()
          : ""
        : undefined;
    const runCommand =
      svc.runCommand !== undefined
        ? typeof svc.runCommand === "string"
          ? svc.runCommand.trim()
          : ""
        : undefined;

    if (lintCommand !== undefined && !lintCommand) {
      errors.push(`services[${i}].lintCommand must be a non-empty string when present`);
    }
    if (testCommand !== undefined && !testCommand) {
      errors.push(`services[${i}].testCommand must be a non-empty string when present`);
    }
    if (runCommand !== undefined && !runCommand) {
      errors.push(`services[${i}].runCommand must be a non-empty string when present`);
    }

    services.push({
      name: name || `service-${i}`,
      root: root || ".",
      stack: isCodeCompassStack(stack) ? stack : "node",
      lintCommand: lintCommand || undefined,
      testCommand: testCommand || undefined,
      runCommand: runCommand || undefined,
    });
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { services } };
}

/**
 * Parse config from raw string content (e.g. from workspace_files).
 * Returns validated config or errors.
 */
export function parseCodeCompassConfigFromContent(
  content: string
): { ok: true; value: CodeCompassConfig } | { ok: false; errors: string[] } {
  try {
    const parsed = JSON.parse(content) as unknown;
    return validateCodeCompassConfig(parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid JSON";
    return { ok: false, errors: [msg] };
  }
}
