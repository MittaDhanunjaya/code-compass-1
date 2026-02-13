export type MessageRole = "system" | "user" | "assistant";

/** OpenAI-compatible content part for multimodal messages (text + images). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessageContent = string | ContentPart[];

export type ChatMessage = {
  role: MessageRole;
  content: ChatMessageContent;
};

/** Extract plain text from ChatMessageContent for storage or display. */
export function getTextFromContent(content: ChatMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export type ChatContext = {
  workspaceId?: string | null;
  filePath?: string | null;
  fileContent?: string | null;
  selection?: string | null;
};

export type ChatOptions = {
  context?: ChatContext | null;
  model?: string;
  /** 0 = deterministic, higher = more variation. Use ~0.2–0.4 for debug to reduce repetitive output. */
  temperature?: number;
  /** 1 = deterministic (no nucleus sampling). Use with temperature=0 for reproducible output. */
  topP?: number;
  /** Phase 4.2.2: Per-request token cap (max output tokens). */
  maxTokens?: number;
  /** Abort signal for streaming: cancel on timeout or client disconnect. */
  signal?: AbortSignal | null;
};

export type LLMUsage = {
  /** Input tokens (prompt) if provided by the provider. */
  inputTokens?: number;
  /** Output tokens (completion) if provided by the provider. */
  outputTokens?: number;
  /** Total tokens if provided by the provider. */
  totalTokens?: number;
  /** Provider-specific raw usage object for debugging. */
  raw?: unknown;
};

/** Phase 4: Stream chunk - content string or usage from final chunk (OpenAI/OpenRouter). */
export type StreamChunk = string | { type: "usage"; usage: LLMUsage };

export type LLMProvider = {
  chat(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage?: LLMUsage }>;

  stream(
    messages: ChatMessage[],
    apiKey: string,
    options?: ChatOptions
  ): AsyncIterable<StreamChunk>;

  /**
   * Generate embeddings for text chunks.
   * Returns array of embedding vectors (1536 dimensions for OpenAI text-embedding-3-small).
   * If provider doesn't support embeddings, returns empty array.
   */
  embeddings?(
    texts: string[],
    apiKey: string
  ): Promise<number[][]>;
};
