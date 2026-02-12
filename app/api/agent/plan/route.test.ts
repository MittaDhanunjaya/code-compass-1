/**
 * Phase 3.4.5: Integration test for agent plan flow.
 * Mocks auth, Supabase; uses MSW for LLM HTTP. Verifies plan is returned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { MOCK_PLAN } from "@/lib/test/mocks/handlers";

const createMockSupabase = () => ({
  from: vi.fn((table: string) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(
        table === "provider_keys"
          ? { data: { key_encrypted: "encrypted" }, error: null }
          : { data: null, error: { code: "PGRST116" } }
      ),
      single: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST116" } }),
      ilike: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    return chain;
  }),
});

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn().mockImplementation(() =>
    Promise.resolve({
      user: { id: "test-user-id" },
      supabase: (() => {
        const chain = (table: string) => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue(
            table === "provider_keys"
              ? { data: { key_encrypted: "encrypted" }, error: null }
              : { data: null, error: { code: "PGRST116" } }
          ),
          single: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST116" } }),
          ilike: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
        });
        return { from: vi.fn((t: string) => chain(t)) };
      })(),
    })
  ),
  withAuthResponse: vi.fn(() => null),
}));

vi.mock("@/lib/encrypt", () => ({
  decrypt: vi.fn().mockResolvedValue("sk-mock-api-key"),
}));

describe("POST /api/agent/plan", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import("@/lib/auth/require-auth");
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: "test-user-id" },
      supabase: createMockSupabase(),
    });
  });

  it("returns 400 for empty instruction", async () => {
    const req = new Request("http://localhost/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-123" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when no workspace", async () => {
    const req = new Request("http://localhost/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "Add a button" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns plan from mocked LLM when valid body and API key", async () => {
    const req = new Request("http://localhost/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "Add a hello world function",
        workspaceId: "00000000-0000-0000-0000-000000000001",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("plan");
    expect(data.plan).toHaveProperty("steps");
    expect(Array.isArray(data.plan.steps)).toBe(true);
    expect(data.plan.steps).toHaveLength(MOCK_PLAN.steps.length);
    expect(data.plan.steps[0]).toMatchObject({
      type: "file_edit",
      path: MOCK_PLAN.steps[0].path,
    });
  });
});
