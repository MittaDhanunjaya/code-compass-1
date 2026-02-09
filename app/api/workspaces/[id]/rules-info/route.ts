import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasRulesFile } from "@/lib/rules";

const RULES_FILE_PATH = ".aiforge-rules";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const hasRules = await hasRulesFile(supabase, id);
  return NextResponse.json({
    rulesFile: hasRules ? RULES_FILE_PATH : null,
  });
}
