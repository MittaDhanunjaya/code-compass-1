/**
 * Tests for plan-stream: STREAMING_ENABLED, empty output retry, fallback provider.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { MOCK_PLAN_JSON } from "@/lib/test/mocks/handlers";
import { http, HttpResponse } from "msw";
import { server } from "@/lib/test/mocks/node";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

const createMockSupabase = () => ({
  from: vi.fn((table: string) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(
      table === "workspaces"
        ? { data: { id: "ws-123" }, error: null }
        : { data: null, error: null }
    ),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
  })),
  rpc: vi.fn().mockResolvedValue({ error: null }),
});

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(),
  withAuthResponse: vi.fn(() => null),
}));

vi.mock("@/lib/workspaces/active-workspace", () => ({
  resolveWorkspaceId: vi.fn().mockResolvedValue("550e8400-e29b-41d4-a716-446655440000"),
}));

vi.mock("@/lib/config", () => ({
  isStreamingEnabled: vi.fn().mockReturnValue(true),
  isWeakModelsEnabled: vi.fn().mockReturnValue(true),
  isOfflineMode: vi.fn().mockReturnValue(false),
  isDeterministicPlanning: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/api-rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  getRateLimitIdentifier: vi.fn().mockReturnValue("test"),
}));

vi.mock("@/lib/stream-caps", () => ({
  acquireStreamSlot: vi.fn().mockResolvedValue({ ok: true }),
  releaseStreamSlot: vi.fn(),
}));

vi.mock("@/lib/llm/budget-guard", () => ({
  enforceAndRecordBudget: vi.fn().mockResolvedValue(undefined),
  refundBudget: vi.fn().mockResolvedValue(undefined),
  STREAMING_RESERVE_TOKENS: 1000,
  estimateTokensFromChars: vi.fn(() => 100),
  recordLLMBudgetReserved: vi.fn(),
  recordLLMBudgetRefunded: vi.fn(),
  recordLLMBudgetExceeded: vi.fn(),
}));

vi.mock("@/lib/models/invocation-config", () => ({
  resolveInvocationConfig: vi.fn().mockResolvedValue([
    {
      modelId: "test-model",
      modelLabel: "Test Model",
      providerId: "openrouter",
      modelSlug: "openrouter/free",
      apiKey: "sk-test-key",
    },
    {
      modelId: "fallback-model",
      modelLabel: "Fallback Model",
      providerId: "openrouter",
      modelSlug: "openrouter/aurora-alpha",
      apiKey: "sk-test-key",
    },
  ]),
  getConfigByRole: vi.fn((configs: unknown[]) => (configs as unknown[])[0]),
}));

vi.mock("@/lib/encrypt", () => ({
  decrypt: vi.fn().mockResolvedValue("sk-mock-api-key"),
}));

vi.mock("@/services/tools/registry", () => ({
  validateToolName: vi.fn(),
  validateToolInput: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  logAgentStarted: vi.fn(),
  logAgentCompleted: vi.fn(),
  getRequestId: vi.fn(() => "test-request-id"),
}));

vi.mock("@/lib/sentry", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  recordAgentPlanDuration: vi.fn(),
  recordLLMBudgetReserved: vi.fn(),
  recordLLMBudgetRefunded: vi.fn(),
  recordLLMBudgetExceeded: vi.fn(),
  recordLLMStreamAbortedTimeout: vi.fn(),
  recordLLMStreamAbortedClient: vi.fn(),
}));

function isPlannerRequest(body: { messages?: Array<{ role?: string; content?: string }> }): boolean {
  const sys = body.messages?.find((m) => m.role === "system")?.content ?? "";
  return sys.includes("planner") || sys.includes("JSON plan");
}

describe("POST /api/agent/plan-stream", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import("@/lib/auth/require-auth");
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: "test-user-id" },
      supabase: createMockSupabase(),
    });
  });

  it("uses non-streaming path when STREAMING_ENABLED=false", async () => {
    const config = await import("@/lib/config");
    vi.mocked(config.isStreamingEnabled).mockReturnValueOnce(false);

    const req = new Request("http://localhost/api/agent/plan-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "Add a comment to src/example.ts",
        workspaceId: VALID_UUID,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let planReceived = false;
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const text = decoder.decode(value);
        const lines = text.split("\n").filter((l) => l.startsWith("data: "));
        for (const line of lines) {
          try {
            const json = JSON.parse(line.slice(6));
            if (json.type === "plan" && json.plan) {
              planReceived = true;
              break;
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    expect(planReceived).toBe(true);
  });

  it("returns EMPTY_RESPONSE after retry same provider, then fallback, when both return empty", async () => {
    let callCount = 0;
    server.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", async ({ request }) => {
        callCount++;
        const body = (await request.json()) as { stream?: boolean };
        if (isPlannerRequest(body as { messages?: Array<{ role?: string; content?: string }> })) {
          return HttpResponse.json({
            id: "chatcmpl-mock",
            choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
          });
        }
        return HttpResponse.json({
          id: "chatcmpl-mock",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      })
    );

    const req = new Request("http://localhost/api/agent/plan-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "Add a comment",
        workspaceId: VALID_UUID,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let foundError = false;
    let errorCode = "";
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const text = decoder.decode(value);
        const lines = text.split("\n").filter((l) => l.startsWith("data: "));
        for (const line of lines) {
          try {
            const json = JSON.parse(line.slice(6));
            if (json.type === "error" || json.code === "EMPTY_RESPONSE") {
              foundError = true;
              errorCode = json.code ?? json.type ?? "";
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    expect(foundError).toBe(true);
    expect(errorCode).toBe("EMPTY_RESPONSE");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("attempts fallback provider when primary returns invalid JSON twice, planning continues if fallback succeeds", async () => {
    let callCount = 0;
    server.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", async ({ request }) => {
        callCount++;
        const body = (await request.json()) as { messages?: Array<{ role?: string; content?: string }>; model?: string };
        if (!isPlannerRequest(body)) {
          return HttpResponse.json({
            id: "chatcmpl-mock",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        if (callCount <= 2) {
          return HttpResponse.json({
            id: "chatcmpl-mock",
            choices: [{ index: 0, message: { role: "assistant", content: "invalid json {{{" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        return HttpResponse.json({
          id: "chatcmpl-mock",
          choices: [{ index: 0, message: { role: "assistant", content: MOCK_PLAN_JSON }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      })
    );

    const req = new Request("http://localhost/api/agent/plan-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "Add a comment",
        workspaceId: VALID_UUID,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let planReceived = false;
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const text = decoder.decode(value);
        const lines = text.split("\n").filter((l) => l.startsWith("data: "));
        for (const line of lines) {
          try {
            const json = JSON.parse(line.slice(6));
            if (json.type === "plan" && json.plan?.steps?.length) {
              planReceived = true;
              break;
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    expect(planReceived).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});
