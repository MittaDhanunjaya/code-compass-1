/**
 * Central budget guard for LLM calls.
 * All LLM invocations must pass this guard before hitting providers.
 * Uses atomic enforce_and_record_tokens RPC to prevent race conditions.
 * Phase 3: Circuit breaker on infra errors (503), refund queue on failure.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDailyLimit, getWorkspaceDailyLimit } from "@/lib/token-budget";
import { isInfraFailure } from "@/lib/llm/rate-limit";
import {
  checkTokenBudget,
  checkWorkspaceTokenBudget,
  incrementTokenUsage,
  incrementWorkspaceTokenUsage,
} from "@/lib/token-budget";
import { LLM_CONFIG } from "@/lib/config/constants";

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  readonly statusCode = 429;
  readonly retryAfter: number;

  constructor(
    message: string,
    public readonly scope: "user" | "workspace",
    retryAfter = 86400
  ) {
    super(message);
    this.name = "BudgetExceededError";
    this.retryAfter = retryAfter;
  }
}

/** Phase 3: Circuit breaker - fail fast with 503 on Supabase infra errors. */
export class ServiceUnavailableError extends Error {
  readonly code = "SERVICE_UNAVAILABLE";
  readonly statusCode = 503;

  constructor(message = "Service temporarily unavailable. Please try again shortly.") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Per-request hard token cap. Enforced on every LLM call.
 */
export const PER_REQUEST_MAX_TOKENS = LLM_CONFIG.DEFAULT_MAX_TOKENS;

/** Reserve this many tokens before streaming (unknown output size). */
export const STREAMING_RESERVE_TOKENS = Math.min(50_000, PER_REQUEST_MAX_TOKENS * 4);

/**
 * Refund unused reserved tokens after stream completion or early abort.
 * Caps at 0; does not weaken atomic enforcement.
 * Phase 3: On failure, enqueues to refund_queue for async retry. Does not block.
 */
export async function refundBudget(
  supabase: SupabaseClient,
  userId: string,
  tokensToRefund: number,
  workspaceId?: string | null
): Promise<void> {
  if (tokensToRefund <= 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const start = Date.now();
  const { error } = await supabase.rpc("refund_tokens", {
    p_user_id: userId,
    p_tokens: tokensToRefund,
    p_workspace_id: workspaceId ?? null,
    p_date: date,
  });
  const { recordSupabaseRpcLatency, recordRefundFailure } = await import("@/lib/metrics");
  recordSupabaseRpcLatency(Date.now() - start);

  if (error) {
    recordRefundFailure();
    const { logger } = await import("@/lib/logger");
    logger.warn({ event: "budget_refund_failed", userId, tokensToRefund, error: error.message });
    const { enqueueRefund } = await import("@/lib/refund-queue");
    enqueueRefund(supabase, userId, tokensToRefund, workspaceId).catch(() => {});
  }
}

/**
 * Atomic check + increment. Reserves tokens before LLM call.
 * When requestId is provided, uses idempotent reserve: retries with same requestId do not double-charge.
 * Call once before each LLM request. Throws BudgetExceededError when over limit.
 * Prevents race: concurrent requests cannot exceed daily budgets.
 */
export type EnforceBudgetOptions = {
  /** When true, skip workspace budget (use only user budget). For fallback when workspace limit exceeded. */
  skipWorkspaceBudget?: boolean;
};

export async function enforceAndRecordBudget(
  supabase: SupabaseClient,
  userId: string,
  tokensToReserve: number,
  workspaceId?: string | null,
  requestId?: string | null,
  options?: EnforceBudgetOptions
): Promise<void> {
  if (tokensToReserve <= 0) return;
  const capped = Math.min(tokensToReserve, PER_REQUEST_MAX_TOKENS * 2);
  const date = new Date().toISOString().slice(0, 10);

  // Phase 4: Per-request cost ceiling
  try {
    const { checkPerRequestCostCeiling } = await import("@/lib/cost-guardrails");
    checkPerRequestCostCeiling(capped);
  } catch (e) {
    throw new BudgetExceededError(
      e instanceof Error ? e.message : "Request cost exceeds limit.",
      "user",
      60
    );
  }
  const userLimit = getDailyLimit();
  const wsLimit = options?.skipWorkspaceBudget ? null : (workspaceId ? getWorkspaceDailyLimit() : null);
  const effectiveWorkspaceId = options?.skipWorkspaceBudget ? null : workspaceId;

  // Phase 4: Redis shadow cache - fail fast when cache shows exhausted
  const { isBudgetExhaustedCached, setBudgetExhaustedCache } = await import("@/lib/budget-cache");
  if (await isBudgetExhaustedCached(userId, date, "user")) {
    throw new BudgetExceededError("Daily token budget exceeded. Try again tomorrow.", "user", 86400);
  }
  if (effectiveWorkspaceId && (await isBudgetExhaustedCached(userId, date, "workspace", effectiveWorkspaceId))) {
    throw new BudgetExceededError("Workspace daily token limit exceeded. Try again tomorrow.", "workspace", 86400);
  }

  const rpcName = requestId ? "reserve_budget_idempotent" : "enforce_and_record_tokens";
  const rpcParams = requestId
    ? {
        p_request_id: requestId,
        p_user_id: userId,
        p_tokens: capped,
        p_user_limit: userLimit,
        p_workspace_id: effectiveWorkspaceId ?? null,
        p_workspace_limit: wsLimit,
        p_date: date,
      }
    : {
        p_user_id: userId,
        p_tokens: capped,
        p_user_limit: userLimit,
        p_workspace_id: effectiveWorkspaceId ?? null,
        p_workspace_limit: wsLimit,
        p_date: date,
      };

  const start = Date.now();
  const { error } = await supabase.rpc(rpcName, rpcParams);
  const { recordSupabaseRpcLatency, recordBudgetEnforcementFailure } = await import("@/lib/metrics");
  recordSupabaseRpcLatency(Date.now() - start);

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("BUDGET_EXCEEDED:workspace")) {
      setBudgetExhaustedCache(userId, date, "workspace", effectiveWorkspaceId ?? workspaceId).catch(() => {});
      throw new BudgetExceededError(
        "Workspace daily token limit exceeded. Try again tomorrow.",
        "workspace",
        86400
      );
    }
    if (msg.includes("BUDGET_EXCEEDED") || msg.includes("token budget")) {
      setBudgetExhaustedCache(userId, date, "user").catch(() => {});
      throw new BudgetExceededError(
        "Daily token budget exceeded. Try again tomorrow.",
        "user",
        86400
      );
    }
    if (isInfraFailure(error)) {
      recordBudgetEnforcementFailure();
      throw new ServiceUnavailableError("Budget service temporarily unavailable. Please try again shortly.");
    }
    if (!requestId && msg.includes("function") && msg.includes("does not exist")) {
      const userBudget = await checkTokenBudget(supabase, userId);
      if (!userBudget.ok) throw new BudgetExceededError("Daily token budget exceeded. Try again tomorrow.", "user", 86400);
      if (effectiveWorkspaceId) {
        const wsBudget = await checkWorkspaceTokenBudget(supabase, effectiveWorkspaceId);
        if (!wsBudget.ok) throw new BudgetExceededError("Workspace daily token limit exceeded. Try again tomorrow.", "workspace", 86400);
      }
      await incrementTokenUsage(supabase, userId, capped);
      if (effectiveWorkspaceId) await incrementWorkspaceTokenUsage(supabase, effectiveWorkspaceId, capped);
      return;
    }
    recordBudgetEnforcementFailure();
    throw error;
  }

  // Phase 4: Burn-rate alert (async, fire-and-forget)
  import("@/lib/cost-guardrails").then(({ recordTokenBurnAndAlert }) =>
    recordTokenBurnAndAlert(userId, capped, date).catch(() => {})
  );
}

/**
 * @deprecated Use enforceAndRecordBudget. Kept for backwards compatibility during migration.
 */
export async function enforceBudget(
  supabase: SupabaseClient,
  userId: string,
  workspaceId?: string | null
): Promise<void> {
  await enforceAndRecordBudget(supabase, userId, STREAMING_RESERVE_TOKENS, workspaceId);
}

/**
 * @deprecated Budget is now reserved atomically before the call. No post-call recording needed.
 * Kept for fallback when RPC is unavailable; prefer enforceAndRecordBudget.
 */
export async function recordTokenUsage(
  _supabase: SupabaseClient,
  _userId: string,
  _tokens: number,
  _workspaceId?: string | null
): Promise<void> {
  // No-op: tokens are reserved via enforceAndRecordBudget before the call.
}

/**
 * Rough token estimate from character count (~4 chars per token).
 * Fallback when tokenizer unavailable.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}
