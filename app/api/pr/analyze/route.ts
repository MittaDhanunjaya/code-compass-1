/**
 * POST /api/pr/analyze
 * PR assistant: given a PR diff (or patch text), return summary, risks, and suggested fixes/tests.
 * Body: { diffText: string; workspaceId?: string; provider?: string; model?: string }
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProvider, getModelForProvider, PROVIDERS, type ProviderId } from "@/lib/llm/providers";
import { invokeChat } from "@/lib/llm/invoke";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { decrypt } from "@/lib/encrypt";

const SYSTEM_PROMPT = `You are a code review assistant. Given a pull request diff (patch), produce:
1. A short summary (2-4 sentences) of what the PR changes.
2. A list of risks or concerns (e.g. breaking changes, missing error handling, performance, security). Use bullet points. If none, say "No major risks identified."
3. Concrete suggestions: targeted fixes or tests to add (bullet points). Be brief.

Respond with valid JSON only, no markdown code fence, in this exact shape:
{"summary":"...","risks":["...","..."],"suggestions":["...","..."]}`;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { diffText?: string; workspaceId?: string; provider?: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const diffText = typeof body.diffText === "string" ? body.diffText.trim() : "";
  if (!diffText || diffText.length > 500_000) {
    return NextResponse.json(
      { error: "diffText is required and must be under 500000 characters" },
      { status: 400 }
    );
  }

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  const providerId = (body.provider as ProviderId) ?? "openrouter";
  const modelOpt = getModelForProvider(providerId, body.model);

  let apiKey: string | null = null;
  let resolvedProvider: ProviderId | null = null;
  const toTry = [providerId, ...PROVIDERS.filter((p) => p !== providerId)];
  for (const p of toTry) {
    const { data: row } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", user.id)
      .eq("provider", p)
      .maybeSingle();
    if (!row?.key_encrypted) continue;
    try {
      apiKey = decrypt(row.key_encrypted);
      resolvedProvider = p;
      break;
    } catch {
      continue;
    }
  }

  if (!apiKey || !resolvedProvider) {
    return NextResponse.json(
      { error: "No API key configured. Add one in Settings → API Keys." },
      { status: 400 }
    );
  }

  const userMessage = `Analyze this PR diff:\n\n${diffText.slice(0, 120000)}`;
  let content: string;
  try {
    const response = await invokeChat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      apiKey,
      providerId: resolvedProvider,
      model: modelOpt,
      task: "review",
    });
    content = response?.content ?? "";
  } catch (e) {
    console.error("PR analyze error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Analysis failed" },
      { status: 502 }
    );
  }

  // Parse JSON from response (may be wrapped in markdown)
  let json: { summary?: string; risks?: string[]; suggestions?: string[] };
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    json = JSON.parse(stripped) as typeof json;
  } catch {
    json = {
      summary: content.slice(0, 1000),
      risks: [],
      suggestions: [],
    };
  }

  return NextResponse.json({
    summary: json.summary ?? "",
    risks: Array.isArray(json.risks) ? json.risks : [],
    suggestions: Array.isArray(json.suggestions) ? json.suggestions : [],
    workspaceId: workspaceId ?? undefined,
  });
}
