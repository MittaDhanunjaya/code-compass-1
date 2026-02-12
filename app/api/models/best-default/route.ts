import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { getBestDefaultModel } from "@/lib/models/invocation-config";
import type { ProviderId } from "@/lib/llm/providers";
import { PROVIDER_LABELS } from "@/lib/llm/providers";

/**
 * GET /api/models/best-default
 * Returns the best default model for this user: first from the app-computed default group
 * (free models + API-connected models, free first). Used for Chat, Composer, Cmd+K, and tab completion
 * when the user has not set a preference. User can always change the model in the UI.
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
