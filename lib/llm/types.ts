export type MessageRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: MessageRole;
  content: string;
};

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
  ): AsyncIterable<string>;

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
