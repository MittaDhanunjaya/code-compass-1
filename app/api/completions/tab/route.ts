import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { getModelForProvider } from "@/lib/llm/providers";
import { getBestDefaultModel, getCompletionModel } from "@/lib/models/invocation-config";
import { invokeChat } from "@/lib/llm/router";
import { tabCompletionCache, getTabCompletionKey, searchCache, getSearchKey } from "@/lib/cache";
import { logger } from "@/lib/logger";
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/** Tab completion uses OpenRouter; fallback when best-default is not OpenRouter. */
const TAB_COMPLETION_FALLBACK = "openrouter/free";
/** Timeout (ms) when trying Ollama first so we don't block on an unavailable local server. */
const OLLAMA_TRY_TIMEOUT_MS = 2500;

/** Max characters of prefix/suffix (shorter = faster, more instant feel). */
const PREFIX_MAX = 320;
const SUFFIX_MAX = 120;

export async function POST(request: Request) {
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

  const rl = await checkRateLimit(getRateLimitIdentifier(request, user.id), "completions-tab", 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again later.", retryAfter: rl.retryAfter },
      { status: 429, headers: rl.retryAfter ? { "Retry-After": String(rl.retryAfter) } : {} }
    );
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

  // Prefer Ollama first when available (local, low latency), then completion model, then best default
  let model = body.model?.trim() ? getModelForProvider("openrouter", body.model) : null;
  let useOllamaFirst = false;
  let ollamaModel = "qwen:latest";
  if (!model) {
    const completionModel = await getCompletionModel(supabase, user.id);
    const best = await getBestDefaultModel(supabase, user.id);
    if (completionModel?.providerId === "ollama" || best?.providerId === "ollama") {
      useOllamaFirst = true;
      ollamaModel = (completionModel?.providerId === "ollama" ? completionModel?.modelSlug : best?.modelSlug) ?? "qwen:latest";
    }
    if (!model && completionModel?.providerId === "openrouter") {
      model = completionModel.modelSlug;
    }
    if (!model && best?.providerId === "openrouter") {
      model = best.modelSlug;
    }
    if (!model) model = TAB_COMPLETION_FALLBACK;
  }

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

  // Check cache first
  const cacheKey = getTabCompletionKey(workspaceId, filePath, prefix, suffix || "");
  const cached = tabCompletionCache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ completion: cached, cached: true });
  }

  // Get codebase context only when prefix is substantial (reduces latency); skip or use short timeout for instant feel
  let codebaseContext = "";
  if (workspaceId && filePath && prefix.length > 180) {
    try {
      const searchQuery = prefix.slice(-120);
      const searchCacheKey = getSearchKey(workspaceId, searchQuery, 2, true);
      let searchData: { results?: Array<{ path: string; preview: string }> } | null = null;
      const cachedSearch = searchCache.get(searchCacheKey);
      if (cachedSearch) {
        searchData = cachedSearch as { results?: Array<{ path: string; preview: string }> };
      } else {
        const searchPromise = fetch(
          `${request.headers.get("origin") || "http://localhost:3000"}/api/search?query=${encodeURIComponent(searchQuery)}&workspaceId=${workspaceId}&limit=2&semantic=true`
        );
        const timeoutPromise = new Promise((resolve) =>
          setTimeout(() => resolve(null), 120)
        );
        
        const result = await Promise.race([searchPromise, timeoutPromise]);
        if (result && result instanceof Response && result.ok) {
          searchData = await result.json();
          if (searchData?.results) {
            searchCache.set(
              searchCacheKey,
              { results: searchData.results, count: searchData.results.length },
              300000
            );
          }
        }
      }
      
      if (searchData?.results && searchData.results.length > 0) {
        const contextFiles = searchData.results
          .filter((r) => r.path !== filePath)
          .slice(0, 1) // Only 1 file for speed
          .map((r) => `${r.path}: ${r.preview.slice(0, 150)}`) // Shorter preview
          .join("\n");
        if (contextFiles) {
          codebaseContext = `\nSimilar: ${contextFiles}`;
        }
      }
    } catch (e) {
      logger.debug({ event: "tab_completion_codebase_context_failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  const systemPrompt = `You are a code completion assistant. Given the code before the cursor (and optionally after), return ONLY the next few lines or expression that would complete the code. Match the style and patterns from the codebase when provided. No explanation, no markdown, no backticks. Output nothing else.`;
  const userPrompt = filePath
    ? `File: ${filePath} (${language})\n\nBefore cursor:\n\`\`\`\n${prefix}\n\`\`\`\n${suffix ? `After cursor:\n\`\`\`\n${suffix}\n\`\`\`\n` : ""}${codebaseContext}Completion:`
    : `Language: ${language}\n\nBefore cursor:\n\`\`\`\n${prefix}\n\`\`\`\n${suffix ? `After cursor:\n\`\`\`\n${suffix}\n\`\`\`\n` : ""}${codebaseContext}Completion:`;

  if (useOllamaFirst) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TRY_TIMEOUT_MS);
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          stream: false,
        }),
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = (await res.json()) as { message?: { content?: string } };
        const raw = (data.message?.content ?? "").trim();
        const completionText = raw.replace(/\n?```[\w]*\n?/g, "").trim();
        if (completionText) {
          tabCompletionCache.set(cacheKey, completionText, 30000);
          return NextResponse.json({ completion: completionText });
        }
      }
    } catch {
      // Ollama unavailable or timeout; fall through to OpenRouter
    }
  }

  const { data: keyRow } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", user.id)
    .eq("provider", "openrouter")
    .single();

  if (!keyRow?.key_encrypted) {
    return NextResponse.json(
      { error: "No OpenRouter API key configured. Tab completion uses OpenRouter when Ollama is not selected; add a key in API Keys." },
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

  try {
    const { content } = await invokeChat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      apiKey,
      providerId: "openrouter",
      model: getModelForProvider("openrouter", model) ?? model,
      task: "chat",
      maxTokens: 200,
      temperature: 0.1,
      userId: user.id,
      workspaceId: workspaceId || undefined,
      supabase,
    });

    const raw = (content ?? "").trim();
    const completionText = raw.replace(/\n?```[\w]*\n?/g, "").trim();

    if (completionText) {
      tabCompletionCache.set(cacheKey, completionText, 30000);
    }

    return NextResponse.json({ completion: completionText });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Completion failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
