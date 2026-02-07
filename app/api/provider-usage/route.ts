import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import type { ProviderId } from "@/lib/llm/providers";

type UsageSummary = {
  provider: ProviderId;
  supported: boolean;
  detail?: string;
};

async function getOpenAIUsage(apiKey: string): Promise<UsageSummary> {
  // Minimal implementation using OpenAI's usage API.
  // If this fails (e.g. endpoint changes), we surface a clear message.
  try {
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 24 * 60 * 60;
    const url = `https://api.openai.com/v1/usage?start_time=${oneDayAgo}&end_time=${now}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        provider: "openai",
        supported: false,
        detail:
          text.slice(0, 200) ||
          `OpenAI usage endpoint returned ${res.status}. Check your plan in the OpenAI dashboard.`,
      };
    }
    const data = await res.json();
    const total = (data as any)?.total_usage;
    const detail =
      typeof total === "number"
        ? `Approx. usage in last 24h: ${total} units (see OpenAI dashboard for details).`
        : "Usage fetched, but response format was unexpected. Check the OpenAI dashboard for exact numbers.";
    return { provider: "openai", supported: true, detail };
  } catch (e) {
    return {
      provider: "openai",
      supported: false,
      detail:
        e instanceof Error
          ? `Failed to call OpenAI usage API: ${e.message}`
          : "Failed to call OpenAI usage API.",
    };
  }
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider") as ProviderId | null;
  if (!provider) {
    return NextResponse.json(
      { error: "provider query parameter is required" },
      { status: 400 }
    );
  }

  // Look up the stored key for this provider.
  const { data: keyRow } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", user.id)
    .eq("provider", provider)
    .single();

  if (!keyRow?.key_encrypted) {
    return NextResponse.json(
      {
        error: `No API key configured for ${provider}. Add one in API Key settings first.`,
      },
      { status: 400 }
    );
  }

  let apiKey: string;
  try {
    apiKey = decrypt(keyRow.key_encrypted);
  } catch {
    return NextResponse.json(
      {
        error:
          "Failed to decrypt API key. Try re-saving your key in API Key settings.",
      },
      { status: 500 }
    );
  }

  if (provider === "openai") {
    const summary = await getOpenAIUsage(apiKey);
    return NextResponse.json({ usage: summary });
  }

  // For now, Gemini and Perplexity do not have wired usage endpoints here.
  const summary: UsageSummary = {
    provider,
    supported: false,
    detail:
      provider === "gemini"
        ? "Usage and limits are best viewed in Google AI Studio / Google Cloud console. Header-based rate limits are handled during requests."
        : "Usage details are not yet wired via API for this provider. Please use the provider dashboard to see detailed usage.",
  };
  return NextResponse.json({ usage: summary });
}

