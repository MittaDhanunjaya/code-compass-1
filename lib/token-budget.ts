/**
 * Phase 4.2.1 & 4.2.4: Per-user daily token budget.
 * Check before LLM call; reject with 429 when over budget.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_DAILY_LIMIT = 100_000; // tokens per user per day
const DEFAULT_WORKSPACE_DAILY_LIMIT = 50_000; // Phase 4.2.3: per workspace

function getDailyLimit(): number {
  const env = process.env.TOKEN_BUDGET_DAILY_PER_USER;
  if (env) {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return DEFAULT_DAILY_LIMIT;
}

function getWorkspaceDailyLimit(): number {
  const env = process.env.TOKEN_BUDGET_WORKSPACE_DAILY;
  if (env) {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return DEFAULT_WORKSPACE_DAILY_LIMIT;
}

/**
 * Get today's date string (YYYY-MM-DD) in UTC.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export type TokenBudgetResult =
  | { ok: true; remaining: number }
  | { ok: false; remaining: 0; retryAfter?: number };

/**
 * Check if user is within daily token budget.
 * Call before LLM invoke. Returns { ok: false } when over limit.
 */
export async function checkTokenBudget(
  supabase: SupabaseClient,
  userId: string
): Promise<TokenBudgetResult> {
  const limit = getDailyLimit();
  const date = todayUtc();

  const { data, error } = await supabase
    .from("token_usage_daily")
    .select("tokens_used")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();

  if (error) {
    // Table might not exist yet; allow request
    return { ok: true, remaining: limit };
  }

  const used = data?.tokens_used ?? 0;
  const remaining = Math.max(0, limit - used);
  if (remaining <= 0) {
    return { ok: false, remaining: 0, retryAfter: 86400 }; // 24h
  }
  return { ok: true, remaining };
}

/**
 * Phase 4.2.3: Check per-workspace daily token budget.
 */
export async function checkWorkspaceTokenBudget(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<TokenBudgetResult> {
  const limit = getWorkspaceDailyLimit();
  const date = todayUtc();

  const { data, error } = await supabase
    .from("token_usage_workspace_daily")
    .select("tokens_used")
    .eq("workspace_id", workspaceId)
    .eq("date", date)
    .maybeSingle();

  if (error) return { ok: true, remaining: limit };

  const used = (data?.tokens_used as number) ?? 0;
  const remaining = Math.max(0, limit - used);
  if (remaining <= 0) {
    return { ok: false, remaining: 0, retryAfter: 86400 };
  }
  return { ok: true, remaining };
}

/**
 * Phase 4.2.3: Increment workspace token usage.
 */
export async function incrementWorkspaceTokenUsage(
  supabase: SupabaseClient,
  workspaceId: string,
  tokens: number
): Promise<void> {
  if (tokens <= 0) return;
  const date = todayUtc();
  const { error } = await supabase.rpc("increment_token_usage_workspace", {
    p_workspace_id: workspaceId,
    p_date: date,
    p_tokens: tokens,
  });
  if (error) {
    const { data } = await supabase
      .from("token_usage_workspace_daily")
      .select("tokens_used")
      .eq("workspace_id", workspaceId)
      .eq("date", date)
      .maybeSingle();
    const current = (data?.tokens_used as number) ?? 0;
    await supabase.from("token_usage_workspace_daily").upsert(
      { workspace_id: workspaceId, date, tokens_used: current + tokens, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id,date" }
    );
  }
}

/**
 * Increment token usage after LLM call.
 */
export async function incrementTokenUsage(
  supabase: SupabaseClient,
  userId: string,
  tokens: number
): Promise<void> {
  if (tokens <= 0) return;

  const date = todayUtc();
  const { error } = await supabase.rpc("increment_token_usage", {
    p_user_id: userId,
    p_date: date,
    p_tokens: tokens,
  });

  if (error) {
    // Fallback when RPC not available (e.g. migration not run)
    const { data } = await supabase
      .from("token_usage_daily")
      .select("tokens_used")
      .eq("user_id", userId)
      .eq("date", date)
      .maybeSingle();

    const current = (data?.tokens_used as number) ?? 0;
    await supabase.from("token_usage_daily").upsert(
      {
        user_id: userId,
        date,
        tokens_used: current + tokens,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,date" }
    );
  }
}
