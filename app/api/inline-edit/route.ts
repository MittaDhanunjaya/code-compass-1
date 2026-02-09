import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";

const INLINE_EDIT_SYSTEM = `You are an inline code editor. You will receive:
1. A file path
2. The current full file content
3. An action: "refactor" or "docs"
4. Optionally the user's selected snippet (they want that part refactored or documented)

Your job: Output ONLY the complete new file content. No markdown, no \`\`\` wrapper, no explanation before or after.
- For "refactor": improve the code (clarity, structure, style). Change only what's needed; keep the rest identical.
- For "docs": add documentation comments (JSDoc, docstrings, or similar) to the code. Keep behavior unchanged.

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
    action: "refactor" | "docs";
    provider?: string;
    model?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { filePath, currentContent, selection, action } = body;
  if (!filePath || typeof currentContent !== "string") {
    return NextResponse.json(
      { error: "filePath and currentContent are required" },
      { status: 400 }
    );
  }
  if (action !== "refactor" && action !== "docs") {
    return NextResponse.json(
      { error: "action must be 'refactor' or 'docs'" },
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

  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const providersToTry = PROVIDERS.includes(requestedProvider)
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  let apiKey: string | null = null;
  let providerId: ProviderId | null = null;
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
      providerId = p;
      break;
    } catch {
      continue;
    }
  }

  if (!apiKey || !providerId) {
    return NextResponse.json(
      {
        error: `No API key configured. Add one in Settings → API Keys (e.g. ${PROVIDER_LABELS[requestedProvider]}).`,
      },
      { status: 400 }
    );
  }

  let rulesPrompt = "";
  const rules = await loadRules(supabase, workspaceId);
  rulesPrompt = formatRulesForPrompt(rules);

  const selectionNote = selection && selection.trim()
    ? `\nThe user has selected this part to ${action}:\n\`\`\`\n${selection.slice(0, 8000)}\n\`\`\``
    : "";
  const userContent = `Action: ${action}
File: ${filePath}
${rulesPrompt ? `Project rules to follow:\n${rulesPrompt}\n` : ""}
Current full file content:
\`\`\`
${currentContent}
\`\`\`
${selectionNote}

Return ONLY the complete new file content (no markdown, no explanation).`;

  try {
    const provider = getProvider(providerId);
    const modelOpt = getModelForProvider(providerId, body.model);
    const { content } = await provider.chat(
      [
        { role: "system", content: INLINE_EDIT_SYSTEM },
        { role: "user", content: userContent },
      ],
      apiKey,
      { model: modelOpt }
    );

    let newContent = typeof content === "string" ? content.trim() : "";
    const codeBlockMatch = newContent.match(/^```(?:[\w]*)\n?([\s\S]*?)```$/m);
    if (codeBlockMatch) {
      newContent = codeBlockMatch[1].trimEnd();
    }
    if (!newContent || newContent.length < 2) {
      newContent = currentContent;
    }

    return NextResponse.json({
      path: filePath.trim(),
      newContent,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Inline edit failed";
    console.error("[POST /api/inline-edit]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
