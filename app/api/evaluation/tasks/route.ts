import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { EVAL_TASKS } from "@/lib/eval/tasks";

/**
 * GET /api/evaluation/tasks
 * Returns the list of synthetic eval tasks for running the eval suite across models/prompts.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    tasks: EVAL_TASKS,
    hint: "Use these task IDs with the agent (e.g. paste instruction) or with scripts/run-eval to run the suite and compare models.",
  });
}
