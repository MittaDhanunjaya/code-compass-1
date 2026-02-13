/**
 * Phase 4: Provider usage reconciliation.
 * When OpenAI/OpenRouter returns usage tokens, reconcile reserved vs actual and adjust budget delta.
 * Does NOT weaken atomic enforcement. Uses charge_additional_tokens for actual > reserved.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { refundBudget } from "./budget-guard";

export type UsageReconciliationResult = {
  reserved: number;
  actual: number;
  refunded: number;
  charged: number;
  drift: number;
};

/**
 * Reconcile reserved vs actual tokens. Refunds when actual < reserved; charges when actual > reserved.
 * Logs reconciliation drift metrics.
 */
export async function reconcileBudgetWithUsage(
  supabase: SupabaseClient,
  userId: string,
  tokensReserved: number,
  tokensActual: number,
  workspaceId?: string | null
): Promise<UsageReconciliationResult> {
  const drift = tokensActual - tokensReserved;
  let refunded = 0;
  let charged = 0;

  if (tokensReserved > tokensActual) {
    refunded = tokensReserved - tokensActual;
    if (refunded > 0) {
      await refundBudget(supabase, userId, refunded, workspaceId);
    }
  } else if (tokensActual > tokensReserved) {
    charged = tokensActual - tokensReserved;
    if (charged > 0) {
      const date = new Date().toISOString().slice(0, 10);
      const { error } = await supabase.rpc("charge_additional_tokens", {
        p_user_id: userId,
        p_tokens: charged,
        p_workspace_id: workspaceId ?? null,
        p_date: date,
      });
      if (error) {
        const { logger } = await import("@/lib/logger");
        logger.warn({
          event: "budget_reconciliation_charge_failed",
          userId,
          charged,
          error: error.message,
        });
        const { recordReconciliationChargeFailure } = await import("@/lib/metrics");
        recordReconciliationChargeFailure();
      }
    }
  }

  const { recordReconciliationDrift } = await import("@/lib/metrics");
  recordReconciliationDrift(drift);

  return {
    reserved: tokensReserved,
    actual: tokensActual,
    refunded,
    charged,
    drift,
  };
}
