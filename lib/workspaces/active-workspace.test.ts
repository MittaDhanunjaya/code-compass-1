import { describe, it, expect, vi } from "vitest";
import {
  getActiveWorkspaceIdForUser,
  setActiveWorkspaceIdForUser,
  resolveWorkspaceId,
} from "./active-workspace";

function createMockSupabase(overrides: {
  userState?: { data: { active_workspace_id: string | null }; error: { code: string } | null };
  workspaceFetch?: { data: { id: string } | null; error: unknown };
  upsertError?: unknown;
} = {}) {
  const {
    userState = { data: null, error: { code: "PGRST116" } },
    workspaceFetch = { data: { id: "ws-1" }, error: null },
    upsertError = null,
  } = overrides;

  const fromImpl = vi.fn((table: string) => {
    if (table === "user_workspace_state") {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.single = vi.fn(() => Promise.resolve(userState));
      chain.upsert = vi.fn(() => Promise.resolve({ error: upsertError }));
      return chain;
    }
    if (table === "workspaces") {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.single = vi.fn(() => Promise.resolve(workspaceFetch));
      return chain;
    }
    return {};
  });

  const supabaseFull = {
    from: fromImpl,
  } as import("@supabase/supabase-js").SupabaseClient;

  return { supabase: supabaseFull, userState, workspaceFetch, upsertError };
}

describe("getActiveWorkspaceIdForUser", () => {
  it("returns null when no row exists (PGRST116)", async () => {
    const { supabase } = createMockSupabase({
      userState: { data: null, error: { code: "PGRST116" } },
    });
    const result = await getActiveWorkspaceIdForUser(supabase, "user-1");
    expect(result).toBeNull();
  });

  it("returns active_workspace_id when row exists", async () => {
    const { supabase } = createMockSupabase({
      userState: { data: { active_workspace_id: "ws-123" }, error: null },
    });
    const result = await getActiveWorkspaceIdForUser(supabase, "user-1");
    expect(result).toBe("ws-123");
  });

  it("returns null when active_workspace_id is null in row", async () => {
    const { supabase } = createMockSupabase({
      userState: { data: { active_workspace_id: null }, error: null },
    });
    const result = await getActiveWorkspaceIdForUser(supabase, "user-1");
    expect(result).toBeNull();
  });
});

describe("setActiveWorkspaceIdForUser", () => {
  it("throws when workspace not found or not owned", async () => {
    const { supabase } = createMockSupabase({
      workspaceFetch: { data: null, error: new Error("not found") },
    });
    await expect(
      setActiveWorkspaceIdForUser(supabase, "user-1", "ws-other")
    ).rejects.toThrow("Workspace not found or access denied");
  });

  it("throws when workspace exists but not owned (empty data)", async () => {
    const { supabase } = createMockSupabase({
      workspaceFetch: { data: null, error: null },
    });
    await expect(
      setActiveWorkspaceIdForUser(supabase, "user-1", "ws-other")
    ).rejects.toThrow("Workspace not found or access denied");
  });

  it("calls upsert when workspace is valid", async () => {
    const { supabase } = createMockSupabase({
      workspaceFetch: { data: { id: "ws-1" }, error: null },
      userState: { data: null, error: { code: "PGRST116" } },
    });
    await expect(
      setActiveWorkspaceIdForUser(supabase, "user-1", "ws-1")
    ).resolves.toBeUndefined();
    expect(supabase.from).toHaveBeenCalledWith("workspaces");
    expect(supabase.from).toHaveBeenCalledWith("user_workspace_state");
  });

  it("allows setting null to clear active workspace", async () => {
    const { supabase } = createMockSupabase();
    await expect(
      setActiveWorkspaceIdForUser(supabase, "user-1", null)
    ).resolves.toBeUndefined();
    // Should not fetch workspace when clearing
    expect(supabase.from).toHaveBeenCalledWith("user_workspace_state");
  });
});

describe("resolveWorkspaceId", () => {
  it("returns explicit workspaceId when provided", async () => {
    const { supabase } = createMockSupabase();
    const result = await resolveWorkspaceId(supabase, "user-1", "ws-explicit");
    expect(result).toBe("ws-explicit");
  });

  it("returns trimmed explicit id", async () => {
    const { supabase } = createMockSupabase();
    const result = await resolveWorkspaceId(supabase, "user-1", "  ws-trim  ");
    expect(result).toBe("ws-trim");
  });

  it("falls back to active workspace when explicit is empty", async () => {
    const { supabase } = createMockSupabase({
      userState: { data: { active_workspace_id: "ws-active" }, error: null },
    });
    const result = await resolveWorkspaceId(supabase, "user-1", undefined);
    expect(result).toBe("ws-active");
  });

  it("returns null when no explicit and no active workspace", async () => {
    const { supabase } = createMockSupabase({
      userState: { data: null, error: { code: "PGRST116" } },
    });
    const result = await resolveWorkspaceId(supabase, "user-1", null);
    expect(result).toBeNull();
  });
});
