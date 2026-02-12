/**
 * Phase 3.4.2: Verify MSW intercepts LLM HTTP requests.
 */

import { describe, it, expect } from "vitest";
import { MOCK_STREAM_CONTENT } from "./handlers";

describe("MSW LLM handlers", () => {
  it("mocks OpenRouter non-streaming chat completion", async () => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(data.choices?.[0]?.message?.content).toBe(MOCK_STREAM_CONTENT);
  });

  it("mocks OpenRouter streaming chat completion", async () => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain(MOCK_STREAM_CONTENT.split(" ")[0]);
  });

  it("mocks OpenAI non-streaming chat completion", async () => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(data.choices?.[0]?.message?.content).toBe(MOCK_STREAM_CONTENT);
  });
});
