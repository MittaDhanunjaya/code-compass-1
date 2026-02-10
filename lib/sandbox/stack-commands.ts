/**
 * Detect project stack and pick lint/test commands.
 * Used by sandbox pipeline to run the right commands per language.
 * When .code-compass/config.json exists, its commands are used first.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { loadCodeCompassConfigSync } from "@/lib/config/code-compass-config";
import { getStackProfile } from "./stack-profiles";

export type StackKind = "node" | "python" | "go" | "java" | "rust" | "dotnet" | "unknown";

/** Priority order for package.json "scripts" lint: first match wins. */
const LINT_SCRIPT_PRIORITY = ["lint", "lint:fix", "lint:check", "eslint", "check"];

/** Priority order for package.json "scripts" test: first match wins. */
const TEST_SCRIPT_PRIORITY = ["test:unit", "test", "test:ci", "test:run", "jest", "vitest", "jest:ci", "vitest:run"];

export function getNodeLintCommand(sandboxDir: string): string | null {
  const p = join(sandboxDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const json = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = json?.scripts ?? {};
    for (const name of LINT_SCRIPT_PRIORITY) {
      if (typeof scripts[name] === "string") return `npm run ${name}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function getNodeTestCommand(sandboxDir: string): string | null {
  const p = join(sandboxDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const json = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = json?.scripts ?? {};
    for (const name of TEST_SCRIPT_PRIORITY) {
      if (typeof scripts[name] === "string") return `npm run ${name}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** Heuristic: detect stack from sandbox directory. */
export function detectStack(sandboxDir: string): StackKind {
  if (existsSync(join(sandboxDir, "package.json"))) return "node";
  if (
    existsSync(join(sandboxDir, "go.mod")) ||
    existsSync(join(sandboxDir, "go.sum"))
  )
    return "go";
  if (
    existsSync(join(sandboxDir, "pom.xml")) ||
    existsSync(join(sandboxDir, "build.gradle")) ||
    existsSync(join(sandboxDir, "build.gradle.kts"))
  )
    return "java";
  if (existsSync(join(sandboxDir, "Cargo.toml"))) return "rust";
  if (
    existsSync(join(sandboxDir, "pyproject.toml")) ||
    existsSync(join(sandboxDir, "requirements.txt")) ||
    existsSync(join(sandboxDir, "setup.py"))
  )
    return "python";
  if (readDirForExt(sandboxDir, ".csproj") || readDirForExt(sandboxDir, ".sln")) return "dotnet";
  return "unknown";
}

function readDirForExt(dir: string, ext: string): boolean {
  try {
    const names = readdirSync(dir, { withFileTypes: false }) as string[];
    return names.some((n) => n.endsWith(ext));
  } catch {
    return false;
  }
}

/** Detect stack from a list of workspace file paths (no fs access). */
export function detectStackFromPaths(paths: string[]): StackKind {
  const set = new Set(paths.map((p) => p.replace(/\\/g, "/").split("/").pop() ?? ""));
  if (set.has("package.json")) return "node";
  if (set.has("go.mod") || set.has("go.sum")) return "go";
  if (set.has("pom.xml") || set.has("build.gradle") || set.has("build.gradle.kts")) return "java";
  if (set.has("Cargo.toml")) return "rust";
  if (set.has("pyproject.toml") || set.has("requirements.txt") || set.has("setup.py")) return "python";
  const hasCsproj = paths.some((p) => p.replace(/\\/g, "/").endsWith(".csproj") || p.replace(/\\/g, "/").endsWith(".sln"));
  if (hasCsproj) return "dotnet";
  return "unknown";
}

/** Lint/test commands per stack (when not Node or when Node has no script). */
export const STACK_COMMANDS: Record<
  Exclude<StackKind, "node" | "unknown">,
  { lint: string[]; test: string[] }
> = {
  dotnet: {
    lint: ["dotnet format --verify-no-changes", "dotnet build --no-restore"],
    test: ["dotnet test", "dotnet test --no-build"],
  },
  python: {
    lint: ["ruff check .", "pylint .", "flake8 ."],
    test: ["pytest", "python -m pytest", "pytest test/", "python -m pytest test/"],
  },
  go: {
    lint: ["go vet ./...", "golangci-lint run"],
    test: ["go test ./...", "go test ./..."],
  },
  java: {
    lint: ["mvn checkstyle:check", "mvn validate"],
    test: ["mvn test", "mvn -q test"],
  },
  rust: {
    lint: ["cargo clippy --no-deps", "cargo check"],
    test: ["cargo test", "cargo test --no-fail-fast"],
  },
};

/** Get lint commands to try for this sandbox (ordered). Uses .code-compass/config.json when present. */
export function getLintCommands(sandboxDir: string): string[] {
  const config = loadCodeCompassConfigSync(sandboxDir);
  if (config?.services?.length) {
    const svc = config.services[0];
    if (svc.lintCommand) return [svc.lintCommand];
  }
  const nodeLint = getNodeLintCommand(sandboxDir);
  if (nodeLint) return [nodeLint, "npm run lint", "npm lint", "yarn lint", "pnpm lint"];
  const stack = detectStack(sandboxDir);
  const stackCmds = STACK_COMMANDS[stack as keyof typeof STACK_COMMANDS];
  if (stackCmds) return stackCmds.lint;
  return [];
}

/** Get test commands to try for this sandbox (ordered). Uses .code-compass/config.json when present. */
export function getTestCommands(sandboxDir: string): string[] {
  const config = loadCodeCompassConfigSync(sandboxDir);
  if (config?.services?.length) {
    const svc = config.services[0];
    if (svc.testCommand) return [svc.testCommand];
  }
  const nodeTest = getNodeTestCommand(sandboxDir);
  if (nodeTest) return [nodeTest, "npm test", "npm run test", "yarn test", "pnpm test"];
  const stack = detectStack(sandboxDir);
  const stackCmds = STACK_COMMANDS[stack as keyof typeof STACK_COMMANDS];
  if (stackCmds) return stackCmds.test;
  return [];
}

/** Run commands from stack profile (how to start the app). Used by sandbox run check. Uses .code-compass/config.json when present. */
export function getRunCommands(
  sandboxDir: string
): Array<{ cmd: string; isServer: boolean }> {
  const config = loadCodeCompassConfigSync(sandboxDir);
  if (config?.services?.length && config.services[0].runCommand) {
    return [{ cmd: config.services[0].runCommand, isServer: true }];
  }
  const stack = detectStack(sandboxDir);
  const profile = getStackProfile(stack);
  if (profile?.runCommands?.length) {
    return profile.runCommands.map(({ cmd, isServer }) => ({ cmd, isServer }));
  }
  return [];
}
