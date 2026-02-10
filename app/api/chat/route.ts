import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import type { ChatMessage, ChatContext } from "@/lib/llm/types";
import type { SearchResult } from "@/lib/indexing/types";
import { detectErrorLogKind } from "@/lib/agent/error-log-utils";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";
import { loadChatHistory, saveChatMessage } from "@/lib/chat-memory";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");
  const runType = searchParams.get("runType") as "chat" | "debug" | "agent" | "refactor" | null;
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }
  const validRunTypes = ["chat", "debug", "agent", "refactor"];
  const filter = runType && validRunTypes.includes(runType) ? runType : undefined;
  const history = await loadChatHistory(supabase, workspaceId, user.id, 50, filter);
  return NextResponse.json({ messages: history });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    messages?: ChatMessage[];
    context?: ChatContext | null;
    model?: string;
    provider?: string;
    classifyOnly?: boolean;
    treatAsNormal?: boolean;
    runType?: "chat" | "debug" | "agent" | "refactor";
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  let messages = body.messages ?? [];
  if (messages.length === 0) {
    return NextResponse.json(
      { error: "messages array is required" },
      { status: 400 }
    );
  }

  const lastMessage = messages[messages.length - 1];
  const workspaceId = await resolveWorkspaceId(
    supabase,
    user.id,
    body.context?.workspaceId
  );

  // Load persistent chat history if workspace exists
  if (workspaceId) {
    const history = await loadChatHistory(supabase, workspaceId, user.id, 30);
    if (history.length > 0) {
      // Merge history with current messages (avoid duplicates)
      const historyMap = new Map<string, boolean>();
      history.forEach((m) => {
        const key = `${m.role}:${m.content.slice(0, 50)}`;
        historyMap.set(key, true);
      });

      // Prepend history that's not already in messages
      const newHistory = history.filter((h) => {
        const key = `${h.role}:${h.content.slice(0, 50)}`;
        return !historyMap.has(key) || !messages.some((m) => m.role === h.role && m.content === h.content);
      });

      messages = [...newHistory, ...messages];
    }
  }

  if (body.classifyOnly === true && lastMessage?.role === "user") {
    const text = typeof lastMessage.content === "string" ? lastMessage.content : "";
    const kind = detectErrorLogKind(text);
    return NextResponse.json({
      kind,
      requireConfirmation: kind === "error_log" && !!workspaceId,
      workspaceId: workspaceId ?? undefined,
      activeWorkspaceId: workspaceId ?? undefined,
    });
  }

  if (body.treatAsNormal !== true && lastMessage?.role === "user" && typeof lastMessage.content === "string") {
    const kind = detectErrorLogKind(lastMessage.content);
    if (kind === "error_log" && workspaceId) {
      return NextResponse.json({
        kind: "error_log",
        requireConfirmation: true,
        workspaceId,
        message: "These look like runtime logs. Confirm to debug against workspace or send as normal message.",
      });
    }
  }

  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const providersToTry = PROVIDERS.includes(requestedProvider)
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  let apiKey: string | null = null;
  let providerId: ProviderId | null = null;
  let decryptFailed = false;

  for (const p of providersToTry) {
    const { data: keyRow, error: keyError } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", user.id)
      .eq("provider", p)
      .maybeSingle();

    if (keyError) {
      console.error(`Error fetching key for ${p}:`, keyError);
      continue;
    }

    if (keyRow?.key_encrypted) {
      try {
        apiKey = decrypt(keyRow.key_encrypted);
        providerId = p;
        break;
      } catch (decryptError) {
        console.error(`Error decrypting key for ${p}:`, decryptError);
        decryptFailed = true;
        continue;
      }
    }
  }

  if (!apiKey || !providerId) {
    if (decryptFailed) {
      return NextResponse.json(
        { error: "Stored API key could not be decrypted. Please re-enter your API key in Settings → API Keys." },
        { status: 400 }
      );
    }
    const requestedLabel = requestedProvider ? PROVIDER_LABELS[requestedProvider] : "Selected provider";
    return NextResponse.json(
      {
        error:
          `No API key configured for ${requestedLabel}. Add one in API Key settings.`,
      },
      { status: 400 }
    );
  }

  try {
    // Get the last user message (after history merge)
    const lastMessage = messages[messages.length - 1];
    const codebaseMatch = lastMessage?.content.match(/@codebase\s+"([^"]+)"/i) ||
      lastMessage?.content.match(/@codebase\s+(\S+)/i);
    
    let searchResults: SearchResult[] = [];
    if (codebaseMatch && workspaceId) {
      const searchQuery = codebaseMatch[1];
      try {
        const searchRes = await fetch(
          `${request.headers.get("origin") || "http://localhost:3000"}/api/search?query=${encodeURIComponent(searchQuery)}&workspaceId=${workspaceId}&limit=10&semantic=true`
        );
        if (searchRes.ok) {
          const searchData = await searchRes.json().catch(() => ({}));
          searchResults = Array.isArray((searchData as any)?.results) ? (searchData as any).results : [];
        } else {
          const { data: chunks } = await supabase
            .from("code_chunks")
            .select("file_path, content, symbols, chunk_index")
            .eq("workspace_id", workspaceId)
            .ilike("content", `%${searchQuery}%`)
            .limit(10);
          if (chunks?.length) {
            const queryLower = searchQuery.toLowerCase();
            const resultsMap = new Map<string, SearchResult>();
            for (const chunk of chunks) {
              const path = chunk.file_path;
              const content = chunk.content ?? "";
              const lines = content.split("\n");
              let matchLine: number | undefined;
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(queryLower)) {
                  matchLine = i + 1;
                  break;
                }
              }
              const previewStart = Math.max(0, (matchLine ?? 1) - 2);
              const previewEnd = Math.min(lines.length, previewStart + 5);
              const preview = lines.slice(previewStart, previewEnd).join("\n");
              if (!resultsMap.has(path)) {
                resultsMap.set(path, {
                  path,
                  line: matchLine,
                  preview: preview.slice(0, 500),
                });
              }
            }
            searchResults = Array.from(resultsMap.values()).slice(0, 5);
          }
        }
      } catch (err) {
        console.error("Search failed:", err);
      }
    }

    // Build enhanced messages with search context and rules
    const enhancedMessages: ChatMessage[] = [...messages];
    
    // Load and add project rules (non-throwing)
    let rulesPrompt = "";
    if (workspaceId) {
      try {
        const rules = await loadRules(supabase, workspaceId);
        rulesPrompt = formatRulesForPrompt(rules);
      } catch {
        rulesPrompt = "";
      }
    }
    
    if (searchResults.length > 0) {
      // Add codebase context as a system message before the last user message
      const codebaseContext = `Relevant codebase context from search:\n\n${searchResults
        .map(
          (r) =>
            `File: ${r.path}${r.line ? ` (line ${r.line})` : ""}\n\`\`\`\n${r.preview}\n\`\`\``
        )
        .join("\n\n")}${rulesPrompt}`;
      
      enhancedMessages.splice(enhancedMessages.length - 1, 0, {
        role: "system",
        content: codebaseContext,
      });
    } else if (rulesPrompt) {
      // Add rules even if no search results
      enhancedMessages.splice(enhancedMessages.length - 1, 0, {
        role: "system",
        content: rulesPrompt.trim(),
      });
    }

    const provider = getProvider(providerId);
    let modelOpt = getModelForProvider(providerId, body.model);
    // Fallback so we never pass undefined and risk provider throwing (reliability)
    if (modelOpt == null || modelOpt === "") {
      if (providerId === "openrouter") modelOpt = "openrouter/free";
      else if (providerId === "gemini") modelOpt = "gemini-2.0-flash";
      else if (providerId === "openai") modelOpt = "gpt-4o-mini";
      else if (providerId === "perplexity") modelOpt = "sonar";
      else if (providerId === "ollama") modelOpt = "llama3.2";
    }
    const { content, usage } = await provider.chat(
      enhancedMessages,
      apiKey,
      { context: body.context, model: modelOpt ?? undefined }
    );

    // Save messages to persistent storage
    if (workspaceId) {
      const lastUserMessage = typeof lastMessage.content === "string" ? lastMessage.content : "";
      const runType = body.runType ?? "chat";
      await saveChatMessage(supabase, workspaceId, user.id, "user", lastUserMessage, { runType }).catch(() => {});
      await saveChatMessage(supabase, workspaceId, user.id, "assistant", content, { runType }).catch(() => {});
    }

    const kind = detectErrorLogKind(typeof lastMessage.content === "string" ? lastMessage.content : "");
    const noWorkspaceErrorLog = kind === "error_log" && !workspaceId;
    const contextUsed: { filePaths: string[]; rulesIncluded: boolean } = {
      filePaths: searchResults.map((r) => r.path),
      rulesIncluded: rulesPrompt.length > 0,
    };
    return NextResponse.json({
      content,
      provider: providerId,
      usage,
      kind,
      contextUsed: (contextUsed.filePaths.length > 0 || contextUsed.rulesIncluded) ? contextUsed : undefined,
      ...(noWorkspaceErrorLog ? { noWorkspaceErrorLog: true } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "LLM request failed";
    console.error("[POST /api/chat]", e);
    const userMessage = msg.length > 300 ? `${msg.slice(0, 200)}…` : msg;
    return NextResponse.json(
      { error: userMessage },
      { status: 502 }
    );
  }
}
