import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";

/**
 * GET /api/feedback/analyze
 * Returns feedback counts by source (agent, composer, debug) and helpful (yes/no)
 * for the current user. Use to identify flows with frequent "No" and prioritize improvements.
 */
export async function GET(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { data: rows, error } = await supabase
    .from("feedback")
    .select("source, helpful")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const bySource: Record<string, { yes: number; no: number }> = {
    agent: { yes: 0, no: 0 },
    composer: { yes: 0, no: 0 },
    debug: { yes: 0, no: 0 },
  };

  for (const r of rows ?? []) {
    const s = r.source as "agent" | "composer" | "debug";
    if (!bySource[s]) bySource[s] = { yes: 0, no: 0 };
    if (r.helpful) bySource[s].yes += 1;
    else bySource[s].no += 1;
  }

  return NextResponse.json({
    bySource,
    total: rows?.length ?? 0,
  });
}
