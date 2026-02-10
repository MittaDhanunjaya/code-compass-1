import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import { invokeChat } from "@/lib/llm/invoke";
import { getModelForTask, applyEnvRouting } from "@/lib/llm/task-routing";
import { getPreferredModel } from "@/lib/llm/ab-stats";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";

const INLINE_EDIT_SYSTEM = `You are an inline code editor. You will receive:
1. A file path
2. The current full file content
3. An action: "refactor", "docs", or "fix"
4. Optionally the user's selected snippet or context (e.g. line with error)

Your job: Output ONLY the complete new file content. No markdown, no \`\`\` wrapper, no explanation before or after.
- For "refactor": improve the code (clarity, structure, style). Change only what's needed; keep the rest identical.
- For "docs": add documentation comments (JSDoc, docstrings, or similar) to the code. Keep behavior unchanged.
- For "fix": fix the error at or near the selection. Correct syntax, types, or logic; make minimal changes. If an error message is provided, use it to guide the fix.

Output nothing but the raw file content. If the file is empty or you cannot produce a valid edit, return the original content unchanged.`;

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
    filePath: string;
    currentContent: string;
    selection?: string;
    errorMessage?: string;
    action: "refactor" | "docs" | "fix";
    provider?: string;
    model?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { filePath, currentContent, selection, errorMessage, action } = body;
  if (!filePath || typeof currentContent !== "string") {
    return NextResponse.json(
      { error: "filePath and currentContent are required" },
      { status: 400 }
    );
  }
  if (action !== "refactor" && action !== "docs" && action !== "fix") {
    return NextResponse.json(
      { error: "action must be 'refactor', 'docs', or 'fix'" },
      { status: 400 }
    );
  }

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "No active workspace selected" },
      { status: 400 }
    );
  }

  applyEnvRouting();
  const requestedProvider = (body.provider ?? null) as ProviderId | null;
  let providerId: ProviderId;
  let modelOpt: string | undefined;
  if (requestedProvider && PROVIDERS.includes(requestedProvider)) {
    providerId = requestedProvider;
    modelOpt = getModelForProvider(providerId, body.model ?? undefined);
  } else {
    const preferred = await getPreferredModel(supabase, user.id, "patch");
    const taskModel = getModelForTask("inline_edit");
    providerId = (preferred?.providerId as ProviderId) ?? taskModel.providerId;
    modelOpt = preferred?.modelId ?? taskModel.model ?? getModelForProvider(providerId, body.model ?? undefined);
  }

  const providersToTry = [providerId, ...PROVIDERS.filter((p) => p !== providerId)];
  let apiKey: string | null = null;
  let resolvedProviderId: ProviderId | null = null;
  for (const p of providersToTry) {
    const { data: keyRow, error: keyError } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", user.id)
      .eq("provider", p)
      .maybeSingle();
    if (keyError || !keyRow?.key_encrypted) continue;
    try {
      apiKey = decrypt(keyRow.key_encrypted);
      resolvedProviderId = p;
      break;
    } catch {
      continue;
    }
  }

  if (!apiKey || !resolvedProviderId) {
    return NextResponse.json(
      {
        error: `No API key configured. Add one in Settings → API Keys (e.g. ${PROVIDER_LABELS[providerId]}).`,
      },
      { status: 400 }
    );
  }
  providerId = resolvedProviderId;

  let rulesPrompt = "";
  try {
    const rules = await loadRules(supabase, workspaceId);
    rulesPrompt = formatRulesForPrompt(rules);
  } catch {
    rulesPrompt = "";
  }

  const selectionNote = selection && selection.trim()
    ? `\nThe user has selected this part to ${action}:\n\`\`\`\n${selection.slice(0, 8000)}\n\`\`\``
    : "";
  const errorNote = action === "fix" && errorMessage
    ? `\nError message (use to guide the fix):\n${errorMessage.slice(0, 500)}\n`
    : "";
  const userContent = `Action: ${action}
File: ${filePath}
${rulesPrompt ? `Project rules to follow:\n${rulesPrompt}\n` : ""}
Current full file content:
\`\`\`
${currentContent}
\`\`\`
${selectionNote}
${errorNote}

Return ONLY the complete new file content (no markdown, no explanation).`;

  try {
    const { content } = await invokeChat({
      messages: [
        { role: "system", content: INLINE_EDIT_SYSTEM },
        { role: "user", content: userContent },
      ],
      apiKey,
      providerId,
      model: modelOpt,
      task: "inline_edit",
    });

    let newContent = typeof content === "string" ? content.trim() : "";
    const codeBlockMatch = newContent.match(/^```(?:[\w]*)\n?([\s\S]*?)```$/m);
    if (codeBlockMatch) {
      newContent = codeBlockMatch[1].trimEnd();
    }
    if (!newContent || newContent.length < 2) {
      return NextResponse.json({
        path: filePath.trim(),
        newContent: currentContent,
        error: "No edit generated. Try again or use Chat.",
      });
    }

    return NextResponse.json({
      path: filePath.trim(),
      newContent,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Inline edit failed";
    console.error("[POST /api/inline-edit]", e);
    const userMsg = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
    return NextResponse.json({ error: userMsg }, { status: 502 });
  }
}
