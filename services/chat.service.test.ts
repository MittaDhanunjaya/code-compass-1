/**
 * Production hardening: Budget refund on stream completion and abort.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChatStream } from "./chat.service";

vi.mock("@/lib/llm/budget-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/budget-guard")>();
  return {
    ...actual,
    refundBudget: vi.fn().mockResolvedValue(undefined),
    estimateTokensFromChars: (chars: number) => Math.ceil(chars / 4),
  };
});

vi.mock("@/lib/llm/budget-reconciliation", () => ({
  reconcileBudgetWithUsage: vi.fn().mockResolvedValue({ refunded: 0, charged: 0, drift: 0 }),
}));

vi.mock("@/lib/metrics", () => ({
  recordLLMBudgetRefunded: vi.fn(),
  recordLLMStreamAbortedTimeout: vi.fn(),
  recordLLMStreamAbortedClient: vi.fn(),
}));

vi.mock("@/lib/llm/providers", () => ({
  getProvider: vi.fn(() => ({
    stream: async function* () {
      yield "Hello ";
      yield "world";
    },
  })),
  getModelForProvider: () => "test-model",
}));

describe("createChatStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refunds unused tokens on normal completion when budget provided", async () => {
    const { refundBudget } = await import("@/lib/llm/budget-guard");
    const { recordLLMBudgetRefunded } = await import("@/lib/metrics");

    const request = new Request("http://test");
    const stream = createChatStream({
      messages: [{ role: "user", content: "Hi" }],
      providerKeys: [{ providerId: "openrouter", apiKey: "sk-test" }],
      request,
      budget: {
        userId: "user-1",
        workspaceId: "ws-1",
        tokensReserved: 1000,
        supabase: {} as never,
      },
    });

    const reader = stream.getReader();
    let done = false;
    while (!done) {
      const { done: d } = await reader.read();
      done = d;
    }

    expect(refundBudget).toHaveBeenCalled();
    const [_, __, refunded] = (refundBudget as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(refunded).toBeGreaterThan(0);
    expect(refunded).toBeLessThanOrEqual(1000);
    expect(recordLLMBudgetRefunded).toHaveBeenCalledWith(refunded);
  });

  it("refunds on early error (simulates abort) - finally runs", async () => {
    const { getProvider } = await import("@/lib/llm/providers");
    vi.mocked(getProvider).mockReturnValueOnce({
      stream: async function* () {
        yield "a";
        throw new Error("Simulated abort");
      },
    } as never);

    const { refundBudget } = await import("@/lib/llm/budget-guard");

    const request = new Request("http://test");
    const stream = createChatStream({
      messages: [{ role: "user", content: "Hi" }],
      providerKeys: [{ providerId: "openrouter", apiKey: "sk-test" }],
      request,
      budget: {
        userId: "user-1",
        workspaceId: null,
        tokensReserved: 500,
        supabase: {} as never,
      },
    });

    const reader = stream.getReader();
    let done = false;
    while (!done) {
      const { done: d } = await reader.read();
      done = d;
    }

    expect(refundBudget).toHaveBeenCalled();
    const [_, userId, tokens, workspaceId] = (refundBudget as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userId).toBe("user-1");
    expect(tokens).toBeGreaterThan(0);
    expect(workspaceId).toBeNull();
  });

  it("provider yields usage-only then closes → terminal error emitted", async () => {
    const { getProvider } = await import("@/lib/llm/providers");
    vi.mocked(getProvider).mockReturnValueOnce({
      stream: async function* () {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      },
    } as never);

    const request = new Request("http://test");
    const stream = createChatStream({
      messages: [{ role: "user", content: "Hi" }],
      providerKeys: [{ providerId: "openrouter", apiKey: "sk-test" }],
      request,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (value) fullText += decoder.decode(value);
      if (done) break;
    }

    const parsed = JSON.parse(fullText.trim().split("\n").filter(Boolean).pop()!);
    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("AI_STREAM_FAILED");
    expect(parsed.provider).toBe("openrouter");
    expect(typeof parsed.reason).toBe("string");
  });

  it("calls reconcileBudgetWithUsage when provider yields usage", async () => {
    const { getProvider } = await import("@/lib/llm/providers");
    const { reconcileBudgetWithUsage } = await import("@/lib/llm/budget-reconciliation");
    const { refundBudget } = await import("@/lib/llm/budget-guard");
    vi.mocked(getProvider).mockReturnValueOnce({
      stream: async function* () {
        yield "Hi";
        yield { type: "usage", usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } };
      },
    } as never);

    const request = new Request("http://test");
    const stream = createChatStream({
      messages: [{ role: "user", content: "Hi" }],
      providerKeys: [{ providerId: "openai", apiKey: "sk-test" }],
      request,
      budget: {
        userId: "user-1",
        workspaceId: "ws-1",
        tokensReserved: 1000,
        supabase: {} as never,
      },
    });

    const reader = stream.getReader();
    let done = false;
    while (!done) {
      const { done: d } = await reader.read();
      done = d;
    }

    expect(reconcileBudgetWithUsage).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      1000,
      60,
      "ws-1"
    );
    expect(refundBudget).not.toHaveBeenCalled();
  });
});
