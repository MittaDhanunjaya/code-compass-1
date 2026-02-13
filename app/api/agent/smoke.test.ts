/**
 * Pre-launch smoke tests for public beta reliability.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as executeStreamPOST } from "./execute-stream/route";
import { GET as healthGET } from "../health/route";
import { POST as beautifyPOST } from "../tools/beautify/route";
import { hashPlan } from "@/lib/agent/plan-lock";
import { classifyTerminalError } from "@/lib/agent/terminal-error-classifier";
import { classifyExecutionError } from "@/lib/agent/execution-error-classifier";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

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
    { modelId: "m1", modelLabel: "OpenRouter", providerId: "openrouter", modelSlug: "openrouter/free", apiKey: "sk-x" },
  ]),
  getConfigByRole: vi.fn((c: unknown[]) => c[0]),
}));

vi.mock("@/lib/encrypt", () => ({
  decrypt: vi.fn().mockResolvedValue("sk-mock"),
}));

vi.mock("@/services/tools/registry", () => ({
  validateToolName: vi.fn(),
  validateToolInput: vi.fn(),
  acquireToolSlot: vi.fn(),
  releaseToolSlot: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  logAgentStarted: vi.fn(),
  logAgentCompleted: vi.fn(),
  getRequestId: vi.fn(() => "test-id"),
}));

vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));

vi.mock("@/lib/metrics", () => ({
  recordAgentPlanDuration: vi.fn(),
  recordAgentExecuteDuration: vi.fn(),
  recordLLMBudgetReserved: vi.fn(),
  recordLLMBudgetRefunded: vi.fn(),
  recordLLMBudgetExceeded: vi.fn(),
  recordLLMStreamAbortedTimeout: vi.fn(),
  recordLLMStreamAbortedClient: vi.fn(),
}));

vi.mock("@/lib/agent/plan-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/plan-lock")>();
  return {
    ...actual,
    getAllowedPaths: vi.fn(),
  };
});

vi.mock("@/lib/agent/execute-command-server", () => ({
  executeCommandInWorkspace: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("@/lib/agent/self-debug", () => ({
  proposeFixSteps: vi.fn(),
  buildTails: vi.fn((stdout: string, stderr: string) => ({ stdoutTail: stdout.slice(-500), stderrTail: stderr.slice(-500) })),
}));

vi.mock("@/lib/agent/error-recovery", () => ({
  tryErrorRecovery: vi.fn().mockResolvedValue({ fixed: false }),
}));

vi.mock("@/lib/indexing/intelligent-context", () => ({
  buildIntelligentContext: vi.fn().mockResolvedValue({
    relatedFiles: [],
    currentFile: null,
    codebaseStructure: { configFiles: [] },
  }),
}));

vi.mock("@/lib/sandbox", () => ({
  createSandboxFromWorkspace: vi.fn().mockResolvedValue("sandbox-123"),
  applyEditsToSandbox: vi.fn().mockResolvedValue({ filesEdited: [], conflicts: [] }),
  runSandboxChecks: vi.fn().mockResolvedValue({
    lint: { status: "passed" },
    tests: { status: "passed" },
    run: { status: "skipped" },
  }),
  syncSandboxToDisk: vi.fn().mockResolvedValue(undefined),
}));

describe("Pre-launch smoke tests", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import("@/lib/auth/require-auth");
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: "test-user" },
      supabase: createMockSupabase(),
    });
  });

  it("deterministic mode: same plan yields identical normalized output (see plan-normalizer.test.ts)", async () => {
    const { normalizePlanForDeterministic } = await import("@/lib/agent/plan-normalizer");
    const plan = {
      steps: [
        { type: "command" as const, command: "npm test" },
        { type: "file_edit" as const, path: "src/b.ts", newContent: "b" },
        { type: "file_edit" as const, path: "src/a.ts", newContent: "a" },
      ],
      summary: "Test",
    };
    const r1 = normalizePlanForDeterministic(plan);
    const r2 = normalizePlanForDeterministic(plan);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(JSON.stringify(r1.plan)).toBe(JSON.stringify(r2.plan));
      expect(r1.planHash).toBe(r2.planHash);
    }
  });

  it("execution aborts when plan contains undeclared file path (plan-lock)", async () => {
    const planWithUndeclared = {
      steps: [
        { type: "file_edit" as const, path: "src/allowed.ts", newContent: "// allowed" },
        { type: "file_edit" as const, path: "src/unrelated.ts", newContent: "// unrelated" },
        { type: "command" as const, command: "npm test" },
      ],
      summary: "Plan",
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
    const res = await executeStreamPOST(req);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let found = false;
    let code = "";
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const text = decoder.decode(value);
        for (const line of text.split("\n").filter((l) => l.startsWith("data: "))) {
          try {
            const j = JSON.parse(line.slice(6));
            if (j.code === "internal_error") {
              found = true;
              code = j.code;
            }
          } catch {}
        }
      }
    }
    expect(found).toBe(true);
    expect(code).toBe("internal_error");
  });

  it("terminal error classification feeds into repair prompt", () => {
    const r = classifyTerminalError("npm run test", "npm ERR! MODULE_NOT_FOUND", "", 127);
    expect(r.type).toBe("DEPENDENCY_ERROR");
    expect(r.hint).toContain("Do not change application logic");
  });

  it("MODULE_NOT_FOUND triggers dependency-only classification", () => {
    const r = classifyExecutionError(
      "Error: Cannot find module 'vitest'\n    at src/app.test.ts:2:1",
      "",
      1
    );
    expect(r.errorType).toBe("MODULE_NOT_FOUND");
    expect(r.missingDependency).toBe("vitest");
    expect(r.failingFile).toBeTruthy();
  });

  it("repair scope: path not in scope is rejected", async () => {
    const { buildRepairScope, isPathInRepairScope } = await import("@/lib/agent/repair-scope");
    const scope = buildRepairScope("npm test", "at src/app.ts:10", "");
    expect(isPathInRepairScope("src/app.ts", scope)).toBe(true);
    expect(isPathInRepairScope("src/unrelated.ts", scope)).toBe(false);
  });

  it("multi-edit repair rejected when errorType !== MODULE_NOT_FOUND (MULTI_EDIT_REPAIR_REJECTED)", async () => {
    const planCommandOnly = {
      steps: [{ type: "command" as const, command: "npm test" }],
      summary: "Run tests",
    };
    const { getAllowedPaths } = await import("@/lib/agent/plan-lock");
    vi.mocked(getAllowedPaths).mockReturnValue(new Set<string>());

    const { executeCommandInWorkspace } = await import("@/lib/agent/execute-command-server");
    vi.mocked(executeCommandInWorkspace).mockResolvedValue({
      ok: false,
      command: "npm test",
      exitCode: 1,
      stdout: "",
      stderr: "SyntaxError: unexpected token ')' at src/app.test.ts:4:12",
      durationMs: 100,
    });

    const { proposeFixSteps } = await import("@/lib/agent/self-debug");
    vi.mocked(proposeFixSteps).mockResolvedValue([
      { type: "file_edit" as const, path: "src/app.test.ts", newContent: "// fix 1" },
      { type: "file_edit" as const, path: "src/other.ts", newContent: "// fix 2" },
    ]);

    const req = new Request("http://localhost/api/agent/execute-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: planCommandOnly,
        planHash: hashPlan(planCommandOnly),
        workspaceId: VALID_UUID,
      }),
    });
    const res = await executeStreamPOST(req);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let foundReject = false;
    let errorCode = "";
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const text = decoder.decode(value);
        for (const line of text.split("\n").filter((l) => l.startsWith("data: "))) {
          try {
            const j = JSON.parse(line.slice(6));
            if (j.code === "MULTI_EDIT_REPAIR_REJECTED") {
              foundReject = true;
              errorCode = j.code;
            }
          } catch {}
        }
      }
    }
    expect(foundReject).toBe(true);
    expect(errorCode).toBe("MULTI_EDIT_REPAIR_REJECTED");
  });

  it("health exposes deterministicPlanning flag", async () => {
    vi.mocked((await import("@/lib/config")).isDeterministicPlanning).mockReturnValue(true);
    const res = await healthGET(new Request("http://localhost/api/health"));
    const data = await res.json();
    expect(data.deterministicPlanning).toBe(true);
  });

  it("offline mode disables beautify endpoint gracefully", async () => {
    vi.mocked((await import("@/lib/config")).isOfflineMode).mockReturnValue(true);
    const res = await beautifyPOST(
      new Request("http://localhost/api/tools/beautify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "const x=1", language: "javascript" }),
      })
    );
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe("OFFLINE_MODE");
  });
});
