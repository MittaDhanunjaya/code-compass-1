/**
 * Phase 3: Refund queue retry logic tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { enqueueRefund, processRefundQueue } from "./refund-queue";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [],
        error: null,
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnThis(),
    })),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  })),
}));

vi.mock("@/lib/metrics", () => ({
  recordRefundFailure: vi.fn(),
  recordRefundQueueEnqueued: vi.fn(),
}));

describe("refund-queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("enqueueRefund", () => {
    it("inserts into refund_queue when called", async () => {
      const mockInsert = vi.fn().mockResolvedValue({ error: null });
      const supabase = {
        from: vi.fn(() => ({ insert: mockInsert })),
      } as never;

      await enqueueRefund(supabase, "user-1", 500, "ws-1");

      expect(supabase.from).toHaveBeenCalledWith("refund_queue");
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: "user-1",
          tokens: 500,
          workspace_id: "ws-1",
          status: "pending",
          retry_count: 0,
        })
      );
    });

    it("does nothing when tokensToRefund <= 0", async () => {
      const supabase = { from: vi.fn() } as never;

      await enqueueRefund(supabase, "user-1", 0);
      await enqueueRefund(supabase, "user-1", -1);

      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  describe("processRefundQueue", () => {
    it("processes pending items and returns counts", async () => {
      const mockRpc = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(await import("@/lib/supabase/admin")).createAdminClient = vi.fn(() =>
        ({
          from: vi.fn((table: string) => {
            if (table === "refund_queue") {
              return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                or: vi.fn().mockReturnThis(),
                order: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: "id-1",
                      user_id: "user-1",
                      tokens: 100,
                      workspace_id: "ws-1",
                      date: "2025-02-12",
                      retry_count: 0,
                    },
                  ],
                  error: null,
                }),
                update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
              };
            }
            return {};
          }),
          rpc: mockRpc,
        } as never)
      );

      const result = await processRefundQueue({ batchSize: 10 });

      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockRpc).toHaveBeenCalledWith("refund_tokens", {
        p_user_id: "user-1",
        p_tokens: 100,
        p_workspace_id: "ws-1",
        p_date: "2025-02-12",
      });
    });

    it("on RPC failure, marks item for retry with backoff", async () => {
      const mockRpc = vi.fn().mockResolvedValue({ error: { message: "Connection refused" } });
      const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });

      vi.mocked(await import("@/lib/supabase/admin")).createAdminClient = vi.fn(() =>
        ({
          from: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "id-1",
                  user_id: "user-1",
                  tokens: 100,
                  workspace_id: null,
                  date: "2025-02-12",
                  retry_count: 0,
                },
              ],
              error: null,
            }),
            update: mockUpdate,
          })),
          rpc: mockRpc,
        } as never)
      );

      const result = await processRefundQueue({ batchSize: 10 });

      expect(result.failed).toBe(1);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          retry_count: 1,
          last_error: "Connection refused",
        })
      );
    });
  });
});
