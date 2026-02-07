import OpenAI from "openai";
import type { ChatMessage, ChatOptions, LLMProvider, LLMUsage } from "./types";

const PERPLEXITY_BASE = "https://api.perplexity.ai";

function buildMessages(
  messages: ChatMessage[],
  context?: ChatOptions["context"]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemParts: string[] = [];
  if (context?.filePath || context?.fileContent || context?.selection) {
    const parts: string[] = [];
    if (context.filePath) parts.push(`Current file: ${context.filePath}`);
    if (context.fileContent)
      parts.push(`\nFile content:\n\`\`\`\n${context.fileContent}\n\`\`\``);
    if (context.selection)
      parts.push(`\nSelected text:\n\`\`\`\n${context.selection}\n\`\`\``);
    systemParts.push(
      "You are a helpful coding assistant. The user may share context about their current file or selection."
    );
    systemParts.push(parts.join(""));
  }

  // Merge consecutive same-role messages; collect system into systemParts.
  const normalized: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const last = normalized[normalized.length - 1];
    if (last?.role === m.role) {
      last.content += "\n\n" + m.content;
    } else {
      normalized.push({ role: m.role, content: m.content });
    }
  }

  // API expects alternating user/assistant; first turn must be user.
  while (normalized.length > 0 && normalized[0].role === "assistant") {
    normalized.shift();
  }

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemParts.length > 0) {
    result.push({ role: "system", content: systemParts.join("\n\n") });
  }
  for (const { role, content } of normalized) {
    result.push({ role, content });
  }

  return result;
}

export const perplexityProvider: LLMProvider = {
  async chat(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage?: LLMUsage }> {
    const client = new OpenAI({ apiKey, baseURL: PERPLEXITY_BASE });
    const built = buildMessages(messages, options?.context);
    const completion = await client.chat.completions.create({
      model: options?.model ?? "sonar",
      messages: built,
    });
    const content = completion.choices[0]?.message?.content ?? "";
    const usage: LLMUsage | undefined = completion.usage
      ? {
          inputTokens: completion.usage.prompt_tokens ?? undefined,
          outputTokens: completion.usage.completion_tokens ?? undefined,
          totalTokens: completion.usage.total_tokens ?? undefined,
          raw: completion.usage,
        }
      : undefined;
    return { content, usage };
  },

  async *stream(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): AsyncIterable<string> {
    const client = new OpenAI({ apiKey, baseURL: PERPLEXITY_BASE });
    const built = buildMessages(messages, options?.context);
    const stream = await client.chat.completions.create({
      model: options?.model ?? "sonar",
      messages: built,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  },
};
