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
};
