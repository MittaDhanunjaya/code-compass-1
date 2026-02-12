/**
 * Phase 9.1.3: Agent execution flow test.
 * Mocks auth, agent.service; verifies execute route returns plan result.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";

const MOCK_PLAN = {
  steps: [
    { type: "file_edit", path: "src/example.ts", newContent: "// edited" },
  ],
  summary: "Mock plan",
};

const MOCK_RESULT = {
  log: [{ stepIndex: 0, type: "file_edit", status: "ok", message: "Edited src/example.ts" }],
  summary: "Completed 1 step(s).",
  filesEdited: ["src/example.ts"],
};

const createMockSupabase = () => ({
  from: vi.fn((table: string) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(
      table === "workspaces"
        ? { data: { id: "ws-123" }, error: null }
        : { data: { workspace_id: "ws-123" }, error: null }
    ),
    maybeSingle: vi.fn().mockResolvedValue({ data: { workspace_id: "ws-123" }, error: null }),
  })),
});

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(),
  withAuthResponse: vi.fn(() => null),
}));

vi.mock("@/lib/workspaces/active-workspace", () => ({
  resolveWorkspaceId: vi.fn().mockResolvedValue("00000000-0000-0000-0000-000000000001"),
}));

vi.mock("@/services/agent.service", () => ({
  executeAgentPlan: vi.fn(),
  PlanAgentError: class PlanAgentError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "PlanAgentError";
      this.code = code;
    }
  },
}));

describe("POST /api/agent/execute", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import("@/lib/auth/require-auth");
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: "test-user-id" },
      supabase: createMockSupabase(),
    });
    const { executeAgentPlan } = await import("@/services/agent.service");
    vi.mocked(executeAgentPlan).mockResolvedValue({ ok: true, result: MOCK_RESULT });
  });

  it("returns 400 when plan is missing", async () => {
    const req = new Request("http://localhost/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-123" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when plan has no steps", async () => {
    const req = new Request("http://localhost/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: { steps: [] }, workspaceId: "ws-123" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns execution result when plan is valid", async () => {
    const req = new Request("http://localhost/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: MOCK_PLAN,
        workspaceId: "00000000-0000-0000-0000-000000000001",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("log");
    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("filesEdited");
    expect(data.filesEdited).toContain("src/example.ts");
  });

  it("returns 404 when workspace not found", async () => {
    const { PlanAgentError, executeAgentPlan } = await import("@/services/agent.service");
    vi.mocked(executeAgentPlan).mockRejectedValue(new PlanAgentError("No workspace", "no_workspace"));

    const req = new Request("http://localhost/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: MOCK_PLAN, workspaceId: "ws-123" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});
