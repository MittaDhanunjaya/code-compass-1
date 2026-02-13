/**
 * Request validation helpers.
 * Returns { success: true, data } or { success: false, error: string } for 400 responses.
 */

import type { ZodSchema } from "zod";
import { agentPlanOutputSchema, analyzeResultSchema, evalTasksResponseSchema, prAnalyzeOutputSchema, debugFromLogOutputSchema } from "./schemas";

export function validateBody<T>(schema: ZodSchema<T>, body: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const err = result.error as { issues?: Array<{ path?: (string | number)[]; message?: string }> };
  const issues = err?.issues ?? [];
  const first = issues[0];
  const pathStr = first?.path?.length ? String(first.path.join(".")) : "body";
  const message = first?.message ? `${pathStr}: ${first.message}` : "Invalid request body";
  return { success: false, error: message };
}

/** Validate LLM output AgentPlan after JSON parsing (3.2.1). */
export function validateAgentPlanOutput(parsed: unknown): { success: true; data: import("@/lib/agent/types").AgentPlan } | { success: false; error: string } {
  const result = agentPlanOutputSchema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data as import("@/lib/agent/types").AgentPlan };
  }
  const err = result.error as { issues?: Array<{ path?: (string | number)[]; message?: unknown }> };
  const issues = err?.issues ?? [];
  const first = issues[0];
  const pathStr = first?.path?.length ? String(first.path.join(".")) : "plan";
  const rawMsg = first?.message;
  const msg = typeof rawMsg === "string" ? `${pathStr}: ${rawMsg}` : rawMsg instanceof Error ? `${pathStr}: ${rawMsg.message}` : "Invalid plan structure";
  return { success: false, error: msg };
}

/** Validate evaluation analyze result (3.2.3). */
export function validateAnalyzeResult(data: unknown): { success: true; data: import("@/services/evaluation.service").AnalyzeResult } | { success: false; error: string } {
  const result = analyzeResultSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data as import("@/services/evaluation.service").AnalyzeResult };
  const err = result.error as { issues?: Array<{ message?: string }> };
  return { success: false, error: err?.issues?.[0]?.message ?? "Invalid analyze result" };
}

/** Validate evaluation tasks response (3.2.3). */
export function validateEvalTasksResponse(data: unknown): { success: true; data: { tasks: import("@/lib/eval/tasks").EvalTask[]; hint: string } } | { success: false; error: string } {
  const result = evalTasksResponseSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data as { tasks: import("@/lib/eval/tasks").EvalTask[]; hint: string } };
  const err = result.error as { issues?: Array<{ message?: string }> };
  return { success: false, error: err?.issues?.[0]?.message ?? "Invalid eval tasks response" };
}

/** Validate PR analyze LLM output. Returns safe defaults on invalid. */
export function validatePrAnalyzeOutput(parsed: unknown): { summary: string; risks: string[]; suggestions: string[] } {
  const result = prAnalyzeOutputSchema.safeParse(parsed);
  if (result.success) return result.data;
  return { summary: "", risks: [], suggestions: [] };
}

/** Validate debug-from-log LLM output. Returns null fields on invalid. */
export function validateDebugFromLogOutput(parsed: unknown): {
  suspectedRootCause: string | null;
  explanation: string | null;
  verificationCommand: string | null;
  edits: Array<{ path?: string; description?: string; oldContent?: string; newContent?: string }>;
} {
  const result = debugFromLogOutputSchema.safeParse(parsed);
  if (result.success) {
    const d = result.data;
    return {
      suspectedRootCause: typeof d.suspectedRootCause === "string" && d.suspectedRootCause.trim() ? d.suspectedRootCause.trim() : null,
      explanation: typeof d.explanation === "string" && d.explanation.trim() ? d.explanation.trim() : null,
      verificationCommand: typeof d.verificationCommand === "string" && d.verificationCommand.trim() ? d.verificationCommand.trim() : null,
      edits: Array.isArray(d.edits) ? d.edits : [],
    };
  }
  return { suspectedRootCause: null, explanation: null, verificationCommand: null, edits: [] };
}
