import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { hasRulesFile } from "@/lib/rules";

const RULES_FILE_PATH = ".code-compass-rules";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, id, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const hasRules = await hasRulesFile(supabase, id);
  return NextResponse.json({
    rulesFile: hasRules ? RULES_FILE_PATH : null,
  });
}
