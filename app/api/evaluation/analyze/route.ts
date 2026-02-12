import { NextResponse } from "next/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { aggregateDebugFromLogStats } from "@/services/evaluation.service";
import { validateAnalyzeResult } from "@/lib/validation";

/**
 * GET /api/evaluation/analyze
 * Returns aggregated stats for debug-from-log (and sandbox) runs to refine prompts and planning.
 */
export async function GET(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  try {
    const result = await aggregateDebugFromLogStats(supabase, user.id);
    const validation = validateAnalyzeResult(result);
    if (!validation.success) {
      console.error("Evaluation analyze result validation failed:", validation.error);
      return NextResponse.json({
        error: "Invalid evaluation data format",
        details: validation.error,
      }, { status: 500 });
    }
    return NextResponse.json(validation.data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to aggregate stats" },
      { status: 500 }
    );
  }
}
