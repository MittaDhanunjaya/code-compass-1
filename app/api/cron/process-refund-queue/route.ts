/**
 * Phase 3: Cron endpoint to process refund queue.
 * Call via Vercel Cron or external scheduler. Protect with CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { processRefundQueue } from "@/lib/refund-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processRefundQueue({ batchSize: 100 });
    return NextResponse.json({
      ok: true,
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
