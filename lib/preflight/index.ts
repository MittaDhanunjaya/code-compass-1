/**
 * Production preflight checks. Run at startup to block launch if critical systems fail.
 * Used by /api/healthz/preflight and instrumentation.ts (production only).
 */

export type PreflightCheck = {
  name: string;
  ok: boolean;
  message?: string;
};

export type PreflightResult = {
  ok: boolean;
  checks: PreflightCheck[];
};

/** Check: At least 1 model available in catalog */
async function checkModelsAvailable(): Promise<PreflightCheck> {
  try {
    const { MODEL_CATALOG } = await import("@/lib/llm/model-catalog");
    const count = MODEL_CATALOG.all?.length ?? 0;
    if (count < 1) {
      return { name: "models", ok: false, message: "No models in catalog" };
    }
    return { name: "models", ok: true };
  } catch (e) {
    return {
      name: "models",
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Check: Streaming pipeline - provider has stream method */
async function checkStreamingPipeline(): Promise<PreflightCheck> {
  try {
    const { getProvider } = await import("@/lib/llm/providers");
    const provider = getProvider("openrouter");
    if (typeof provider?.stream !== "function") {
      return { name: "streaming", ok: false, message: "Provider missing stream method" };
    }
    // Verify ReadableStream is available (Node 18+)
    if (typeof ReadableStream === "undefined") {
      return { name: "streaming", ok: false, message: "ReadableStream not available" };
    }
    return { name: "streaming", ok: true };
  } catch (e) {
    return {
      name: "streaming",
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Check: Formatter pipeline healthy */
async function checkFormatterPipeline(): Promise<PreflightCheck> {
  try {
    const { formatCode } = await import("@/lib/formatters");
    const result = await formatCode("const x=1;", "javascript");
    if (!result?.formattedCode || typeof result.formattedCode !== "string") {
      return { name: "formatter", ok: false, message: "Formatter returned invalid result" };
    }
    return { name: "formatter", ok: true };
  } catch (e) {
    return {
      name: "formatter",
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Check: Port selection works (find at least one free port) */
async function checkPortSelection(): Promise<PreflightCheck> {
  try {
    const net = await import("net");
    const found = await new Promise<boolean>((resolve) => {
      let port = 3000;
      const tryNext = () => {
        if (port > 3100) {
          resolve(false);
          return;
        }
        const server = net.createServer();
        server.once("error", () => {
          port++;
          tryNext();
        });
        server.once("listening", () => {
          server.close();
          resolve(true);
        });
        server.listen(port, "127.0.0.1");
      };
      tryNext();
    });
    if (!found) {
      return { name: "port", ok: false, message: "No free port in 3000-3100" };
    }
    return { name: "port", ok: true };
  } catch (e) {
    return {
      name: "port",
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Check: Error events / metrics can emit */
async function checkErrorEvents(): Promise<PreflightCheck> {
  try {
    const metrics = await import("@/lib/metrics");
    const recordBudgetEnforcementFailure = metrics.recordBudgetEnforcementFailure;
    if (typeof recordBudgetEnforcementFailure !== "function") {
      return { name: "error_events", ok: false, message: "recordBudgetEnforcementFailure not a function" };
    }
    const logger = await import("@/lib/logger");
    if (typeof logger.logger?.info !== "function") {
      return { name: "error_events", ok: false, message: "Logger not properly configured" };
    }
    return { name: "error_events", ok: true };
  } catch (e) {
    return {
      name: "error_events",
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Check: Budget enforcement active (module loads, BudgetExceededError has correct code) */
async function checkBudgetEnforcement(): Promise<PreflightCheck> {
  try {
    const { enforceAndRecordBudget, BudgetExceededError } = await import("@/lib/llm/budget-guard");
    if (typeof enforceAndRecordBudget !== "function") {
      return { name: "budget", ok: false, message: "enforceAndRecordBudget not a function" };
    }
    const err = new BudgetExceededError("test", "user");
    if (err.code !== "BUDGET_EXCEEDED") {
      return { name: "budget", ok: false, message: "BudgetExceededError.code !== BUDGET_EXCEEDED" };
    }
    return { name: "budget", ok: true };
  } catch (e) {
    return {
      name: "budget",
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

const ALL_CHECKS = [
  checkModelsAvailable,
  checkStreamingPipeline,
  checkFormatterPipeline,
  checkPortSelection,
  checkErrorEvents,
  checkBudgetEnforcement,
];

/**
 * Run all preflight checks. Returns aggregated result.
 */
export async function runPreflightChecks(): Promise<PreflightResult> {
  const results = await Promise.all(ALL_CHECKS.map((fn) => fn()));
  const ok = results.every((r) => r.ok);
  return {
    ok,
    checks: results,
  };
}
