import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/feedback/analyze
 * Returns feedback counts by source (agent, composer, debug) and helpful (yes/no)
 * for the current user. Use to identify flows with frequent "No" and prioritize improvements.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
