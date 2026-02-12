import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import { chatStreamBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";
import { createChatStream, getChatProviderKeys } from "@/services/chat.service";

export async function POST(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth();
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const rl = await checkRateLimit(getRateLimitIdentifier(request, user.id), "chat-stream", 60);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Try again later.", retryAfter: rl.retryAfter }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter ?? 60) } }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const validation = validateBody(chatStreamBodySchema, rawBody);
  if (!validation.success) {
    return new Response(
      JSON.stringify({ error: validation.error }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const body = validation.data;

  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const providerKeys = await getChatProviderKeys(supabase, user.id, requestedProvider);

  if (!providerKeys || providerKeys.length === 0) {
    const { data: anyKeyRow } = await supabase.from("provider_keys").select("id").eq("user_id", user.id).limit(1);
    const hasStoredKey = (anyKeyRow ?? []).length > 0;
    if (hasStoredKey) {
      return new Response(
        JSON.stringify({
          error: "Stored API key could not be decrypted. Please re-enter your API key in Settings → API Keys.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const providersToTry = requestedProvider
      ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
      : [...PROVIDERS];
    const triedLabels = providersToTry.map((p) => PROVIDER_LABELS[p]).join(", ");
    const freeOptions = "OpenRouter (free models available) or Gemini (free tier)";
    return new Response(
      JSON.stringify({
        error:
          `No API key configured for any provider. Tried: ${triedLabels}. ` +
          `Add an API key in Settings → API Keys. Recommended: ${freeOptions}. ` +
          `Get free keys at: OpenRouter (https://openrouter.ai/keys) or Gemini (https://aistudio.google.com/apikey)`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const stream = createChatStream({
    messages: body.messages,
    context: body.context,
    model: body.model,
    providerKeys,
    request,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
