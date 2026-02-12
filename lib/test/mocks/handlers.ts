/**
 * Phase 3.4.2: MSW handlers for mocking LLM HTTP APIs.
 * Used by integration tests to mock OpenAI and OpenRouter chat completions.
 */

import { http, HttpResponse } from "msw";

/** Non-streaming chat completion response (OpenAI format). */
function createChatCompletionJson(content: string) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Streaming chat completion chunks (OpenAI SSE format). */
function* createStreamChunks(content: string): Generator<string> {
  const words = content.split(" ");
  for (let i = 0; i < words.length; i++) {
    const chunk = words[i] + (i < words.length - 1 ? " " : "");
    yield `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    })}\n\n`;
  }
  yield "data: [DONE]\n\n";
}

/**
 * Default plan JSON that the planner LLM should return (for plan/plan-stream tests).
 */
export const MOCK_PLAN = {
  steps: [
    { type: "file_edit", path: "src/example.ts", newContent: "// edited" },
  ],
  summary: "Mock plan",
};

export const MOCK_PLAN_JSON = JSON.stringify(MOCK_PLAN);

/**
 * Default streaming content for chat (for chat/stream tests).
 */
export const MOCK_STREAM_CONTENT = "Hello world from mock";

function isPlannerRequest(body: { messages?: Array<{ role?: string; content?: string }> }): boolean {
  const sys = body.messages?.find((m) => m.role === "system")?.content ?? "";
  return sys.includes("planner") || sys.includes("JSON plan");
}

export const handlers = [
  // OpenAI chat completions (non-streaming and streaming)
  http.post("https://api.openai.com/v1/chat/completions", async ({ request }) => {
    const body = (await request.json()) as { stream?: boolean; messages?: Array<{ role?: string; content?: string }> };
    const content = isPlannerRequest(body) ? MOCK_PLAN_JSON : MOCK_STREAM_CONTENT;
    if (body.stream) {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of createStreamChunks(content)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new HttpResponse(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return HttpResponse.json(createChatCompletionJson(content));
  }),

  // OpenRouter chat completions (non-streaming and streaming)
  http.post("https://openrouter.ai/api/v1/chat/completions", async ({ request }) => {
    const body = (await request.json()) as { stream?: boolean; messages?: Array<{ role?: string; content?: string }> };
    const content = isPlannerRequest(body) ? MOCK_PLAN_JSON : MOCK_STREAM_CONTENT;
    if (body.stream) {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of createStreamChunks(content)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new HttpResponse(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return HttpResponse.json(createChatCompletionJson(content));
  }),
];
