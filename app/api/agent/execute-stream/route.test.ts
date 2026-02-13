/**
 * Tests for execute-stream: plan hash, plan presence, execution guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { hashPlan } from "@/lib/agent/plan-lock";

const MOCK_PLAN = {
  steps: [
    { type: "file_edit" as const, path: "src/example.ts", newContent: "// edited" },
    { type: "command" as const, command: "npm install" },
  ],
  summary: "Mock plan",
};

const createMockSupabase = () => ({
  from: vi.fn((table: string) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(
      table === "workspaces"
        ? { data: { id: "ws-123", safe_edit_mode: true }, error: null }
        : { data: null, error: null }
    ),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    in: vi.fn().mockReturnThis(),
  })),
});

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(),
  withAuthResponse: vi.fn(() => null),
}));

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

vi.mock("@/lib/workspaces/active-workspace", () => ({
  resolveWorkspaceId: vi.fn().mockResolvedValue("550e8400-e29b-41d4-a716-446655440000"),
}));

vi.mock("@/lib/config", () => ({
  isOfflineMode: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/api-rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  getRateLimitIdentifier: vi.fn().mockReturnValue("test"),
}));

vi.mock("@/lib/stream-caps", () => ({
  acquireStreamSlot: vi.fn().mockResolvedValue({ ok: true }),
  releaseStreamSlot: vi.fn(),
}));

vi.mock("@/services/tools/registry", () => ({
  validateToolName: vi.fn(),
  validateToolInput: vi.fn(),
  acquireToolSlot: vi.fn(),
  releaseToolSlot: vi.fn(),
}));

vi.mock("@/lib/llm/budget-guard", () => ({
  enforceAndRecordBudget: vi.fn().mockResolvedValue(undefined),
  STREAMING_RESERVE_TOKENS: 1000,
  recordLLMBudgetReserved: vi.fn(),
  recordLLMBudgetExceeded: vi.fn(),
}));

vi.mock("@/lib/agent/plan-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/plan-lock")>();
  return {
    ...actual,
    getAllowedPaths: vi.fn(),
  };
});

describe("POST /api/agent/execute-stream", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import("@/lib/auth/require-auth");
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: "test-user-id" },
      supabase: createMockSupabase(),
    });
  });

  it("returns 400 when planHash is missing", async () => {
    const req = new Request("http://localhost/api/agent/execute-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: MOCK_PLAN,
        workspaceId: VALID_UUID,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/planHash|required/i);
  });

  it("returns 400 when plan is missing", async () => {
    const req = new Request("http://localhost/api/agent/execute-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: VALID_UUID }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when plan hash mismatches", async () => {
    const correctHash = hashPlan(MOCK_PLAN);
    const wrongHash = correctHash === "aaaaaaaaaaaaaaaa" ? "bbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa";

    const req = new Request("http://localhost/api/agent/execute-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: MOCK_PLAN,
        planHash: wrongHash,
        workspaceId: VALID_UUID,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("PLAN_HASH_MISMATCH");
  });

  it("execution fails if plan hash mismatches", async () => {
    const req = new Request("http://localhost/api/agent/execute-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: MOCK_PLAN,
        planHash: "wrong_hash_value",
        workspaceId: VALID_UUID,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("PLAN_HASH_MISMATCH");
    expect(data.error).toMatch(/modified|re-run/i);
  });

  it("execution aborts with internal_error when plan contains undeclared file path", async () => {
    const planWithUndeclared = {
      steps: [
        { type: "file_edit" as const, path: "src/allowed.ts", newContent: "// allowed" },
        { type: "file_edit" as const, path: "src/undeclared.ts", newContent: "// undeclared" },
        { type: "command" as const, command: "npm install" },
      ],
      summary: "Plan with one allowed, one undeclared",
    };
    const { getAllowedPaths } = await import("@/lib/agent/plan-lock");
    vi.mocked(getAllowedPaths).mockReturnValue(new Set(["src/allowed.ts"]));

    const req = new Request("http://localhost/api/agent/execute-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: planWithUndeclared,
        planHash: hashPlan(planWithUndeclared),
        workspaceId: VALID_UUID,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let foundError = false;
    let errorCode = "";
    let errorMessage = "";
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
            if (json.type === "error" || json.code === "internal_error") {
              foundError = true;
              errorCode = json.code ?? json.type ?? "";
              errorMessage = json.message ?? json.error ?? "";
            }
          } catch {
            /* skip non-JSON */
          }
        }
      }
    }
    expect(foundError).toBe(true);
    expect(errorCode).toBe("internal_error");
    expect(errorMessage).toBe("Execution attempted to modify undeclared file.");
  });
});
