import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBestDefaultModel } from "@/lib/models/invocation-config";
import type { ProviderId } from "@/lib/llm/providers";
import { PROVIDER_LABELS } from "@/lib/llm/providers";

/**
 * GET /api/models/best-default
 * Returns the best default model for this user: first from the app-computed default group
 * (free models + API-connected models, free first). Used for Chat, Composer, Cmd+K, and tab completion
 * when the user has not set a preference. User can always change the model in the UI.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const best = await getBestDefaultModel(supabase, user.id);
  if (!best) {
    return NextResponse.json({
      provider: "openrouter" as ProviderId,
      modelSlug: "openrouter/free",
      label: "Free (auto-select)",
    });
  }

  return NextResponse.json({
    provider: best.providerId,
    modelSlug: best.modelSlug,
    label: best.label,
    providerLabel: PROVIDER_LABELS[best.providerId],
  });
}
