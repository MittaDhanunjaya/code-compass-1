/**
 * Phase 3.4.6: Integration test for /api/chat/stream.
 * Mocks auth, rate limit, Supabase; uses MSW for LLM HTTP.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { MOCK_STREAM_CONTENT } from "@/lib/test/mocks/handlers";

const createMockSupabase = () => ({
  from: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { key_encrypted: "encrypted" }, error: null }),
    limit: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
  })),
});

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn().mockImplementation(() =>
    Promise.resolve({
      user: { id: "test-user-id" },
      supabase: createMockSupabase(),
    })
  ),
  withAuthResponse: vi.fn(() => null),
}));

vi.mock("@/lib/api-rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true, remaining: 59 }),
  getRateLimitIdentifier: vi.fn(() => "test-identifier"),
}));

vi.mock("@/lib/encrypt", () => ({
  decrypt: vi.fn().mockResolvedValue("sk-mock-api-key"),
}));

describe("POST /api/chat/stream", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import("@/lib/auth/require-auth");
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: "test-user-id" },
      supabase: createMockSupabase(),
    });
  });

  it("returns 400 for invalid body", async () => {
    const req = new Request("http://localhost/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("streams LLM response when valid body and API key available", async () => {
    const req = new Request("http://localhost/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
        provider: "openrouter",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.body).toBeInstanceOf(ReadableStream);

    const reader = res.body!.getReader();
    const chunks: string[] = [];
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
    const fullText = chunks.join("");
    expect(fullText).toContain(MOCK_STREAM_CONTENT);
  });
});
