import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import type { ChatMessage, ChatContext } from "@/lib/llm/types";
import { safeEnqueue, safeClose } from "@/lib/stream-utils";

function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    /\b429\b|"code":\s*429|"status":\s*429/.test(msg) ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    lower.includes("quota exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("rate limit exceeded") ||
    lower.includes("too many requests")
  );
}

function isInvalidModelError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    /\b400\b/.test(msg) &&
    (lower.includes("not a valid model") ||
      lower.includes("invalid model") ||
      lower.includes("model_id") ||
      lower.includes("model id"))
  );
}

function getUserFacingError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (isRateLimitError(e)) {
    return "This provider’s rate limit was reached. Try again in a minute or use another provider (API Keys).";
  }
  try {
    const parsed = JSON.parse(msg) as { error?: { message?: string } };
    const inner = parsed?.error?.message;
    if (typeof inner === "string" && inner.length < 300) return inner;
    if (typeof inner === "string") return inner.slice(0, 200) + "…";
  } catch {
    // ignore
  }
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

async function getApiKey(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  userId: string,
  provider: ProviderId
): Promise<string | null> {
  const { data, error } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle(); // Use maybeSingle() instead of single() to avoid throwing on no rows
  
  if (error) {
    console.error(`Error fetching key for ${provider}:`, error);
    return null;
  }
  
  if (!data?.key_encrypted) return null;
  
  try {
    return decrypt(data.key_encrypted);
  } catch (decryptError) {
    console.error(`Error decrypting key for ${provider}:`, decryptError);
    return null;
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  let body: {
    messages?: ChatMessage[];
    context?: ChatContext | null;
    model?: string; // Model selection (for OpenRouter)
    provider?: ProviderId;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const messages = body.messages ?? [];
  if (messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const providersToTry = requestedProvider
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  const providersWithKeys: { providerId: ProviderId; apiKey: string }[] = [];
  for (const p of providersToTry) {
    const key = await getApiKey(supabase, user.id, p);
    if (key) providersWithKeys.push({ providerId: p, apiKey: key });
  }

  if (providersWithKeys.length === 0) {
    const { data: anyKeyRow } = await supabase.from("provider_keys").select("id").eq("user_id", user.id).limit(1);
    const hasStoredKey = (anyKeyRow ?? []).length > 0;
    if (hasStoredKey) {
      return new Response(
        JSON.stringify({ error: "Stored API key could not be decrypted. Please re-enter your API key in Settings → API Keys." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const triedLabels = providersToTry.map(p => PROVIDER_LABELS[p]).join(", ");
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

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        let lastError: unknown = null;
        for (const { providerId, apiKey } of providersWithKeys) {
          try {
            const provider = getProvider(providerId);
            const modelOpt = getModelForProvider(providerId, body.model);
            for await (const chunk of provider.stream(messages, apiKey, {
              context: body.context,
              model: modelOpt,
            })) {
              safeEnqueue(controller, encoder, chunk);
            }
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            if (!isRateLimitError(e) && !isInvalidModelError(e)) {
              safeEnqueue(controller, encoder, `[Error: ${getUserFacingError(e)}]`);
              break;
            }
          }
        }
        if (lastError != null && (isRateLimitError(lastError) || isInvalidModelError(lastError))) {
          safeEnqueue(
            controller,
            encoder,
            `[Error: ${getUserFacingError(lastError)}. Try selecting a different provider (e.g. OpenAI) in the dropdown above if you have an API key.]`
          );
        }
      } catch (e) {
        safeEnqueue(controller, encoder, `[Error: ${getUserFacingError(e)}]`);
      }
      safeClose(controller);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
