import { GoogleGenAI, createUserContent, createModelContent } from "@google/genai";
import type { ChatMessage, ChatOptions, LLMProvider } from "./types";

function buildContents(messages: ChatMessage[], context?: ChatOptions["context"]) {
  const systemParts: string[] = [];

  if (context?.filePath || context?.fileContent || context?.selection) {
    const parts: string[] = [];
    if (context.filePath) parts.push(`Current file: ${context.filePath}`);
    if (context.fileContent) parts.push(`\nFile content:\n\`\`\`\n${context.fileContent}\n\`\`\``);
    if (context.selection) parts.push(`\nSelected text:\n\`\`\`\n${context.selection}\n\`\`\``);
    systemParts.push(
      "You are a helpful coding assistant. The user may share context about their current file or selection.\n\n" +
        parts.join("")
    );
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

  // Gemini requires contents to start with a user message. Drop leading assistant turns.
  while (normalized.length > 0 && normalized[0].role === "assistant") {
    normalized.shift();
  }

  const contents: ReturnType<typeof createUserContent>[] = [];
  for (const { role, content } of normalized) {
    if (role === "user") contents.push(createUserContent(content));
    else contents.push(createModelContent(content));
  }

  const systemInstruction =
    systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  return { contents, systemInstruction };
}

export const geminiProvider: LLMProvider = {
  async chat(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): Promise<{ content: string }> {
    const ai = new GoogleGenAI({ apiKey });
    const { contents, systemInstruction } = buildContents(messages, options?.context);
    const response = await ai.models.generateContent({
      model: options?.model ?? "gemini-2.0-flash",
      contents,
      config: systemInstruction ? { systemInstruction } : undefined,
    });
    return { content: response.text ?? "" };
  },

  async *stream(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): AsyncIterable<string> {
    const ai = new GoogleGenAI({ apiKey });
    const { contents, systemInstruction } = buildContents(messages, options?.context);
    const stream = await ai.models.generateContentStream({
      model: options?.model ?? "gemini-2.0-flash",
      contents,
      config: systemInstruction ? { systemInstruction } : undefined,
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  },
};
