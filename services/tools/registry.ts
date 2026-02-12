/**
 * Agent tool registry. All tools used by the agent must be defined here.
 * Rejects hallucinated or unknown tool calls.
 */

import { z } from "zod";

/** Tool definition: name, input schema, timeout, permissions. */
export type ToolDef = {
  name: string;
  description: string;
  /** Zod schema for input validation. */
  inputSchema: z.ZodType<unknown>;
  /** Timeout in milliseconds. */
  timeoutMs: number;
  /** Permissions required (e.g. "read", "write", "execute"). */
  permissions: readonly string[];
};

/** Schema for search_index: query terms, workspace scope. */
const searchIndexSchema = z.object({
  query: z.string().optional(),
  workspaceId: z.string().optional(),
  limit: z.number().min(1).max(50).optional(),
});

/** Schema for read_file: path to read. */
const readFileSchema = z.object({
  path: z.string().min(1),
});

/** Schema for edit_file: path and content. */
const editFileSchema = z.object({
  path: z.string().min(1),
  oldContent: z.string().optional(),
  newContent: z.string(),
});

/** Schema for run_command: shell command. */
const runCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});

const REGISTRY: Record<string, ToolDef> = {
  search_index: {
    name: "search_index",
    description: "Search the codebase index for relevant files and symbols",
    inputSchema: searchIndexSchema,
    timeoutMs: 15_000,
    permissions: ["read"],
  },
  read_file: {
    name: "read_file",
    description: "Read file contents from the workspace",
    inputSchema: readFileSchema,
    timeoutMs: 5_000,
    permissions: ["read"],
  },
  edit_file: {
    name: "edit_file",
    description: "Edit or create a file in the workspace",
    inputSchema: editFileSchema,
    timeoutMs: 30_000,
    permissions: ["read", "write"],
  },
  run_command: {
    name: "run_command",
    description: "Execute a shell command in the workspace",
    inputSchema: runCommandSchema,
    timeoutMs: 120_000,
    permissions: ["execute"],
  },
};

/** All registered tool names. */
export const REGISTERED_TOOL_NAMES = Object.keys(REGISTRY) as readonly string[];

/**
 * Check if a tool name is registered. Use before executing any tool call.
 */
export function isRegisteredTool(name: string): boolean {
  return name in REGISTRY;
}

/**
 * Validate that a tool is registered. Throws if not.
 */
export function validateToolName(name: string): asserts name is keyof typeof REGISTRY {
  if (!isRegisteredTool(name)) {
    throw new Error(`Unknown tool: "${name}". Registered tools: ${REGISTERED_TOOL_NAMES.join(", ")}`);
  }
}

/**
 * Get tool definition by name.
 */
export function getTool(name: string): ToolDef | null {
  const def = REGISTRY[name];
  return def ?? null;
}

/**
 * Validate tool input against its schema. Returns parsed input or throws.
 */
export function validateToolInput<T>(name: string, input: unknown): T {
  validateToolName(name);
  const def = REGISTRY[name];
  return def.inputSchema.parse(input) as T;
}

/**
 * Get timeout for a tool in ms.
 */
export function getToolTimeoutMs(name: string): number {
  validateToolName(name);
  return REGISTRY[name].timeoutMs;
}

/** Max concurrent tool executions per user. */
const MAX_CONCURRENT_TOOLS_PER_USER = 5;
const activeToolCount = new Map<string, number>();

/**
 * Acquire a slot for tool execution. Call releaseToolSlot when done.
 * Throws if over limit.
 */
export function acquireToolSlot(userId: string): void {
  const count = activeToolCount.get(userId) ?? 0;
  if (count >= MAX_CONCURRENT_TOOLS_PER_USER) {
    throw new Error(`Tool execution limit reached (max ${MAX_CONCURRENT_TOOLS_PER_USER} concurrent). Please wait for current operations to complete.`);
  }
  activeToolCount.set(userId, count + 1);
}

/**
 * Release a tool execution slot.
 */
export function releaseToolSlot(userId: string): void {
  const count = activeToolCount.get(userId) ?? 1;
  if (count <= 1) {
    activeToolCount.delete(userId);
  } else {
    activeToolCount.set(userId, count - 1);
  }
}
