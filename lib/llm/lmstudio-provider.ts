/**
 * LM Studio (desktop): OpenAI-compatible API at localhost. No API key required.
 */

import OpenAI from "openai";
import type { ChatMessage, ChatOptions, LLMProvider, LLMUsage } from "./types";

const LMSTUDIO_BASE = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";

export const lmstudioProvider: LLMProvider = {
  async chat(
    messages: ChatMessage[],
    _apiKey: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage?: LLMUsage }> {
    const model = options?.model ?? "local";
    const client = new OpenAI({ baseURL: LMSTUDIO_BASE, apiKey: "lm-studio" });
    const completion = await client.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
    });
    const content = completion.choices[0]?.message?.content ?? "";
    const usage = completion.usage
      ? {
          inputTokens: completion.usage.prompt_tokens ?? undefined,
          outputTokens: completion.usage.completion_tokens ?? undefined,
          totalTokens: completion.usage.total_tokens ?? undefined,
        }
      : undefined;
    return { content, usage };
  },

  async *stream(
    messages: ChatMessage[],
    _apiKey: string,
    options?: ChatOptions
  ): AsyncIterable<string> {
    const model = options?.model ?? "local";
    const client = new OpenAI({ baseURL: LMSTUDIO_BASE, apiKey: "lm-studio" });
    const stream = await client.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  },
};
