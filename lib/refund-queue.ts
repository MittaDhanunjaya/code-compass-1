/**
 * Phase 3: Background refund queue for failed refundBudget calls.
 * Enqueues on failure; processes with exponential backoff. Does not block request completion.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordRefundFailure, recordRefundQueueEnqueued } from "@/lib/metrics";
import { logger } from "@/lib/logger";

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 300_000; // 5 min

function backoffMs(retryCount: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
}

export type RefundQueueItem = {
  id: string;
  user_id: string;
  tokens: number;
  workspace_id: string | null;
  date: string;
  retry_count: number;
};

/**
 * Enqueue a failed refund for async retry. Does not block.
 * Call when refundBudget fails; request completion continues.
 */
export async function enqueueRefund(
  supabase: SupabaseClient,
  userId: string,
  tokensToRefund: number,
  workspaceId?: string | null
): Promise<void> {
  if (tokensToRefund <= 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from("refund_queue").insert({
    user_id: userId,
    tokens: tokensToRefund,
    workspace_id: workspaceId ?? null,
    date,
    status: "pending",
    retry_count: 0,
    next_retry_at: new Date().toISOString(),
  });
  if (error) {
    recordRefundFailure();
    logger.warn({ event: "refund_queue_enqueue_failed", userId, tokensToRefund, error: error.message });
    return;
  }
  recordRefundQueueEnqueued();
}

/**
 * Process pending refund queue items. Exponential backoff. Call from cron.
 * Uses admin client to bypass RLS.
 */
export async function processRefundQueue(options?: { batchSize?: number }): Promise<{ processed: number; succeeded: number; failed: number }> {
  const batchSize = options?.batchSize ?? 50;
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: items, error: fetchError } = await admin
    .from("refund_queue")
    .select("id, user_id, tokens, workspace_id, date, retry_count")
    .eq("status", "pending")
    .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    logger.error({ event: "refund_queue_fetch_failed", error: fetchError.message });
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

  for (const item of items ?? []) {
    const { error: rpcError } = await admin.rpc("refund_tokens", {
      p_user_id: item.user_id,
      p_tokens: item.tokens,
      p_workspace_id: item.workspace_id,
      p_date: item.date,
    });

    if (!rpcError) {
      const { error: updateError } = await admin
        .from("refund_queue")
        .update({ status: "completed", updated_at: now })
        .eq("id", item.id);
      if (!updateError) succeeded++;
    } else {
      const nextRetry = item.retry_count + 1;
      const isExhausted = nextRetry >= MAX_RETRIES;
      const nextRetryAt = isExhausted ? null : new Date(Date.now() + backoffMs(nextRetry)).toISOString();

      await admin
        .from("refund_queue")
        .update({
          status: isExhausted ? "failed" : "pending",
          retry_count: nextRetry,
          next_retry_at: nextRetryAt,
          last_error: rpcError.message,
          updated_at: now,
        })
        .eq("id", item.id);

      failed++;
      recordRefundFailure();
      if (isExhausted) {
        logger.warn({ event: "refund_queue_exhausted", id: item.id, userId: item.user_id, retries: nextRetry });
      }
    }
  }

  return { processed: items?.length ?? 0, succeeded, failed };
}
