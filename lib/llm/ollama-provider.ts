import type { ChatMessage, ChatOptions, LLMProvider, LLMUsage } from "./types";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export const ollamaProvider: LLMProvider = {
  async chat(
    messages: ChatMessage[],
    _apiKey: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage?: LLMUsage }> {
    const model = options?.model ?? "llama3.2";
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama error ${res.status}: ${t || res.statusText}`);
    }
    const data = (await res.json()) as { message?: { content?: string }; eval_count?: number };
    const content = data.message?.content ?? "";
    return {
      content,
      usage: data.eval_count != null ? { outputTokens: data.eval_count } : undefined,
    };
  },

  async *stream(
    messages: ChatMessage[],
    _apiKey: string,
    options?: ChatOptions
  ): AsyncIterable<string> {
    const model = options?.model ?? "llama3.2";
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama error ${res.status}: ${t || res.statusText}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          if (obj.message?.content) yield obj.message.content;
        } catch {
          // skip malformed chunk
        }
      }
    }
    for (const line of buffer.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { message?: { content?: string } };
        if (obj.message?.content) yield obj.message.content;
      } catch {
        // skip
      }
    }
  },
};
