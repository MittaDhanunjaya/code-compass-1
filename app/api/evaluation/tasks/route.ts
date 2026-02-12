import { NextResponse } from "next/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { getEvalTasks } from "@/services/evaluation.service";
import { validateEvalTasksResponse } from "@/lib/validation";

/**
 * GET /api/evaluation/tasks
 * Returns the list of synthetic eval tasks for running the eval suite across models/prompts.
 */
export async function GET(request: Request) {
  try {
    await requireAuth(request);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { tasks, hint } = getEvalTasks();
  const validation = validateEvalTasksResponse({ tasks, hint });
  if (!validation.success) {
    console.error("Evaluation tasks validation failed:", validation.error);
    return NextResponse.json(
      { error: "Invalid eval tasks format", details: validation.error },
      { status: 500 }
    );
  }
  return NextResponse.json(validation.data);
}
