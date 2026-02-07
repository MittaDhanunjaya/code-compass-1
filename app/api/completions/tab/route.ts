import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getModelForProvider } from "@/lib/llm/providers";
import OpenAI from "openai";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** Tab completion uses OpenRouter; default to free router. */
const TAB_COMPLETION_MODEL = "openrouter/free";

/** Max characters of prefix/suffix to send to the model. */
const PREFIX_MAX = 1200;
const SUFFIX_MAX = 400;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    workspaceId?: string;
    filePath?: string;
    prefix?: string;
    suffix?: string;
    language?: string;
    model?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const workspaceId = (body.workspaceId ?? "").trim();
  const filePath = (body.filePath ?? "").trim();
  const prefix = (body.prefix ?? "").slice(-PREFIX_MAX);
  const suffix = (body.suffix ?? "").slice(0, SUFFIX_MAX);
  const language = body.language ?? "plaintext";
  const model = getModelForProvider("openrouter", body.model?.trim() || null) ?? TAB_COMPLETION_MODEL;

  if (!workspaceId || !prefix) {
    return NextResponse.json(
      { error: "workspaceId and prefix are required" },
      { status: 400 }
    );
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const { data: keyRow } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", user.id)
    .eq("provider", "openrouter")
    .single();

  if (!keyRow?.key_encrypted) {
    return NextResponse.json(
      { error: "No OpenRouter API key configured. Tab completion uses OpenRouter; add a key in API Keys." },
      { status: 400 }
    );
  }

  let apiKey: string;
  try {
    apiKey = decrypt(keyRow.key_encrypted);
  } catch {
    return NextResponse.json(
      { error: "Failed to decrypt API key" },
      { status: 500 }
    );
  }

  const systemPrompt = `You are a code completion assistant. Given the code before the cursor (and optionally after), return ONLY the next few lines or expression that would complete the code. No explanation, no markdown, no backticks. Output nothing else.`;
  const userPrompt = filePath
    ? `File: ${filePath} (${language})\n\nBefore cursor:\n\`\`\`\n${prefix}\n\`\`\`\n${suffix ? `After cursor:\n\`\`\`\n${suffix}\n\`\`\`\n` : ""}Completion:`
    : `Language: ${language}\n\nBefore cursor:\n\`\`\`\n${prefix}\n\`\`\`\n${suffix ? `After cursor:\n\`\`\`\n${suffix}\n\`\`\`\n` : ""}Completion:`;

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE,
      defaultHeaders: {
        "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "https://aiforge.app",
        "X-Title": "AIForge-Tab",
      },
    });

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 150,
      temperature: 0.2,
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const completionText = raw.replace(/\n?```[\w]*\n?/g, "").trim();

    return NextResponse.json({ completion: completionText });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Completion failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
