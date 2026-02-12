/**
 * Zod schemas for API request validation.
 * Phase 3.1: Input validation for high-value routes.
 */

import { z } from "zod";

const PROVIDERS = ["openrouter", "openai", "gemini", "perplexity", "ollama", "lmstudio"] as const;
const providerIdSchema = z.enum(PROVIDERS);

const scopeModeSchema = z.enum(["conservative", "normal", "aggressive"]);

// --- Chat message schema ---
const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const chatContextSchema = z
  .object({
    workspaceId: z.string().uuid().optional().nullable(),
    filePath: z.string().optional().nullable(),
    fileContent: z.string().optional().nullable(),
    selection: z.string().optional().nullable(),
  })
  .optional()
  .nullable();

// --- Agent plan step schemas ---
const fileEditStepSchema = z.object({
  type: z.literal("file_edit"),
  path: z.string().min(1, "path is required"),
  oldContent: z.string().optional(),
  newContent: z.string(),
  description: z.string().optional(),
  source: z.literal("debug-from-log").optional(),
});

const commandStepSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1, "command is required"),
  description: z.string().optional(),
});

const planStepSchema = z.discriminatedUnion("type", [
  fileEditStepSchema,
  commandStepSchema,
]);

const agentPlanSchema = z.object({
  steps: z.array(planStepSchema).min(1, "at least one step is required"),
  summary: z.string().optional(),
});

/** AgentPlan schema for validating LLM output (3.2.1) */
export const agentPlanOutputSchema = agentPlanSchema;

// --- API route body schemas ---

/** /api/agent/plan-stream */
export const agentPlanStreamBodySchema = z.object({
  instruction: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "instruction is required")),
  workspaceId: z.string().uuid().optional(),
  provider: providerIdSchema.optional(),
  model: z.string().optional(),
  modelId: z.string().optional(),
  modelGroupId: z.string().optional(),
  fileList: z.array(z.string()).optional(),
  fileContents: z.record(z.string(), z.string()).optional(),
  useIndex: z.boolean().optional(),
  scopeMode: scopeModeSchema.optional(),
});

/** /api/agent/execute-stream */
export const agentExecuteStreamBodySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  plan: agentPlanSchema,
  provider: providerIdSchema.optional(),
  model: z.string().optional(),
  modelId: z.string().optional(),
  modelGroupId: z.string().optional(),
  confirmedProtectedPaths: z.array(z.string()).optional(),
  skipProtected: z.boolean().optional(),
  scopeMode: scopeModeSchema.optional(),
  confirmedAggressive: z.boolean().optional(),
});

/** /api/chat/stream */
export const chatStreamBodySchema = z.object({
  messages: z.array(chatMessageSchema).min(1, "messages array is required"),
  context: chatContextSchema.optional(),
  model: z.string().optional(),
  provider: providerIdSchema.optional(),
});

/** /api/composer/plan */
const composerScopeSchema = z.enum(["current_file", "current_folder", "workspace"]);

export const composerPlanBodySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  instruction: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "instruction is required")),
  scope: composerScopeSchema.optional(),
  scopeMode: scopeModeSchema.optional(),
  currentFilePath: z.string().optional().nullable(),
  provider: providerIdSchema.optional(),
  model: z.string().optional(),
  fileContents: z.record(z.string(), z.string()).optional(),
});

/** /api/composer/execute */
export const composerExecuteBodySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  steps: z.array(fileEditStepSchema).min(1, "at least one step is required"),
  confirmedProtectedPaths: z.array(z.string()).optional(),
  source: z.string().optional(),
  debugFromLogMeta: z
    .object({
      errorLog: z.string().optional(),
      errorType: z.string().optional(),
      modelUsed: z.string().optional(),
      providerId: z.string().optional(),
    })
    .optional(),
});

// --- Evaluation result schemas (3.2.3) ---
const byErrorTypeEntrySchema = z.object({
  total: z.number(),
  testsPassed: z.number(),
  promoted: z.number(),
  rolledBack: z.number(),
});

const byModelEntrySchema = z.object({
  total: z.number(),
  testsPassed: z.number(),
  promoted: z.number(),
});

export const analyzeResultSchema = z.object({
  summary: z.object({
    totalDebugRuns: z.number(),
    testsPassed: z.number(),
    promoted: z.number(),
    passRate: z.number(),
    promoteRate: z.number(),
    avgTimeToGreenSeconds: z.number().nullable(),
    possibleRegressions: z.number(),
  }),
  byErrorType: z.record(z.string(), byErrorTypeEntrySchema),
  byModel: z.record(z.string(), byModelEntrySchema),
  timeToGreenSeconds: z.array(z.number()).optional(),
  hint: z.string(),
});

export const evalTaskSchema = z.object({
  id: z.string(),
  label: z.string(),
  instruction: z.string(),
  expectedCheck: z.enum(["sandbox_checks_passed", "file_touched", "manual"]),
});

export const evalTasksResponseSchema = z.object({
  tasks: z.array(evalTaskSchema),
  hint: z.string(),
});

// --- 3.1.6: Workspaces, index, feedback schemas ---

/** POST /api/workspaces */
export const workspacesCreateBodySchema = z.object({
  name: z.string().transform((s) => s.trim()).optional(),
  githubRepoUrl: z.string().optional(),
  githubBranch: z.string().optional(),
  fromMyRepo: z
    .object({
      owner: z.string(),
      repo: z.string(),
      defaultBranch: z.string(),
      isPrivate: z.boolean(),
    })
    .optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string().optional(),
      })
    )
    .optional(),
});

/** PATCH /api/workspaces/[id] */
export const workspacesUpdateBodySchema = z.object({
  name: z.string().transform((s) => s.trim()).optional(),
  safe_edit_mode: z.boolean().optional(),
});

/** POST /api/index/update */
export const indexUpdateBodySchema = z.object({
  workspaceId: z.string().uuid(),
  filePaths: z.array(z.string()),
  provider: providerIdSchema.optional(),
  generateEmbeddings: z.boolean().optional(),
});

/** POST /api/feedback */
export const feedbackBodySchema = z.object({
  workspaceId: z.string().uuid().optional().nullable(),
  source: z.enum(["agent", "composer", "debug"]),
  helpful: z.boolean(),
});

// --- Export types ---
export type AgentPlanStreamBody = z.infer<typeof agentPlanStreamBodySchema>;
export type AgentExecuteStreamBody = z.infer<typeof agentExecuteStreamBodySchema>;
export type ChatStreamBody = z.infer<typeof chatStreamBodySchema>;
export type ComposerPlanBody = z.infer<typeof composerPlanBodySchema>;
export type ComposerExecuteBody = z.infer<typeof composerExecuteBodySchema>;
