import OpenAI from "openai";
import type { ChatMessage, ChatOptions, LLMProvider, LLMUsage } from "./types";
import { generateEmbeddings } from "./embeddings";

function buildMessages(messages: ChatMessage[], context?: ChatOptions["context"]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemParts: string[] = [];
  if (context?.filePath || context?.fileContent || context?.selection) {
    const parts: string[] = [];
    if (context.filePath) {
      parts.push(`Current file: ${context.filePath}`);
    }
    if (context.fileContent) {
      parts.push(`\nFile content:\n\`\`\`\n${context.fileContent}\n\`\`\``);
    }
    if (context.selection) {
      parts.push(`\nSelected text:\n\`\`\`\n${context.selection}\n\`\`\``);
    }
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
    result.push({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    });
  }

  return result;
}

export const openAIProvider: LLMProvider = {
  async chat(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage?: LLMUsage }> {
    const client = new OpenAI({ apiKey });
    const built = buildMessages(messages, options?.context);
    const completion = await client.chat.completions.create({
      model: options?.model ?? "gpt-4o-mini",
      messages: built,
      ...(options?.temperature != null && { temperature: options.temperature }),
      ...(options?.topP != null && { top_p: options.topP }),
      ...(options?.maxTokens != null && { max_tokens: options.maxTokens }),
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
  ): AsyncIterable<import("./types").StreamChunk> {
    const client = new OpenAI({ apiKey });
    const built = buildMessages(messages, options?.context);
    const stream = await client.chat.completions.create(
      {
        model: options?.model ?? "gpt-4o-mini",
        messages: built,
        stream: true,
        stream_options: { include_usage: true },
        ...(options?.temperature != null && { temperature: options.temperature }),
        ...(options?.topP != null && { top_p: options.topP }),
        ...(options?.maxTokens != null && { max_tokens: options.maxTokens }),
      },
      options?.signal ? { signal: options.signal } : undefined
    );

    for await (const chunk of stream) {
      if (options?.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
      if (chunk.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? undefined,
            outputTokens: chunk.usage.completion_tokens ?? undefined,
            totalTokens: chunk.usage.total_tokens ?? undefined,
            raw: chunk.usage,
          },
        };
      }
    }
  },

  async embeddings(texts: string[], apiKey: string): Promise<number[][]> {
    return generateEmbeddings(texts, apiKey, "openai");
  },
};
