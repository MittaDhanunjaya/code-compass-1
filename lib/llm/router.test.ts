/**
 * Router: budget guard and production assertions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invokeChat } from "./router";

vi.mock("./invoke", () => ({
  invokeChat: vi.fn().mockResolvedValue({
    content: "ok",
    usage: { totalTokens: 100 },
    providerId: "openrouter",
    model: "openrouter/free",
    latencyMs: 50,
    retries: 0,
  }),
}));

vi.mock("@/lib/llm/budget-guard", () => ({
  enforceAndRecordBudget: vi.fn().mockResolvedValue(undefined),
  BudgetExceededError: class BudgetExceededError extends Error {
    code = "BUDGET_EXCEEDED";
    statusCode = 429;
    retryAfter = 86400;
    constructor(message: string) {
      super(message);
      this.name = "BudgetExceededError";
    }
  },
  STREAMING_RESERVE_TOKENS: 50000,
  PER_REQUEST_MAX_TOKENS: 8192,
}));

describe("router invokeChat", () => {
  const validInput = {
    messages: [{ role: "user" as const, content: "Hi" }],
    apiKey: "sk-test",
    task: "chat" as const,
    userId: "user-1",
    workspaceId: "ws-1",
    supabase: {} as Parameters<typeof invokeChat>[0]["supabase"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("throws in production when userId is missing", async () => {
    process.env.NODE_ENV = "production";
    const inputWithoutUser = { ...validInput, userId: undefined, supabase: {} };
    await expect(invokeChat(inputWithoutUser)).rejects.toThrow("LLM calls require user context in production");
  });

  it("does not throw in test when userId is missing", async () => {
    process.env.NODE_ENV = "test";
    const inputWithoutUser = { ...validInput, userId: undefined, supabase: undefined };
    const { invokeChat: invokeInternal } = await import("./invoke");
    vi.mocked(invokeInternal).mockResolvedValue({
      content: "ok",
      usage: { totalTokens: 100 },
      providerId: "openrouter",
      model: "openrouter/free",
      latencyMs: 50,
      retries: 0,
    });
    await expect(invokeChat(inputWithoutUser)).resolves.toBeDefined();
  });

  it("calls enforceAndRecordBudget when supabase and userId provided", async () => {
    const { enforceAndRecordBudget } = await import("@/lib/llm/budget-guard");
    await invokeChat(validInput);
    expect(enforceAndRecordBudget).toHaveBeenCalledWith(
      validInput.supabase,
      validInput.userId,
      expect.any(Number),
      validInput.workspaceId
    );
  });
});
