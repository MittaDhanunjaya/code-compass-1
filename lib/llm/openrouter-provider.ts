import OpenAI from "openai";
import type { ChatMessage, ChatOptions, LLMProvider, LLMUsage } from "./types";
import { generateEmbeddings } from "./embeddings";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const OPENROUTER_DEFAULT_MODEL = "openrouter/free";

/**
 * All OpenRouter ":free" model IDs are routed through openrouter/free so we never
 * hit 404s when OpenRouter changes or disables specific free endpoints (e.g.
 * deepseek/deepseek-chat:free, deepseek-chat-v3-0324:free). The router picks an
 * available free model automatically.
 */
function normalizeModel(model: string | undefined): string {
  if (!model) return OPENROUTER_DEFAULT_MODEL;
  if (model === OPENROUTER_DEFAULT_MODEL) return model;
  if (model.endsWith(":free")) return OPENROUTER_DEFAULT_MODEL;
  return model;
}

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

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemParts.length > 0) {
    result.push({ role: "system", content: systemParts.join("\n\n") });
  }

  for (const m of messages) {
    result.push({ role: m.role as "system" | "user" | "assistant", content: m.content });
  }

  return result;
}

export const openRouterProvider: LLMProvider = {
  async chat(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage?: LLMUsage }> {
    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE,
      defaultHeaders: {
        "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "https://aiforge.app",
        "X-Title": "AIForge",
      },
    });
    const built = buildMessages(messages, options?.context);
    const completion = await client.chat.completions.create({
      model: normalizeModel(options?.model),
      messages: built,
      ...(options?.temperature != null && { temperature: options.temperature }),
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
    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE,
      defaultHeaders: {
        "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "https://aiforge.app",
        "X-Title": "AIForge",
      },
    });
    const built = buildMessages(messages, options?.context);
    const stream = await client.chat.completions.create({
      model: normalizeModel(options?.model),
      messages: built,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  },

  async embeddings(texts: string[], apiKey: string): Promise<number[][]> {
    return generateEmbeddings(texts, apiKey, "openrouter");
  },
};
