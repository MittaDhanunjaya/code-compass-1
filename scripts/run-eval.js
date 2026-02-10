#!/usr/bin/env node
/**
 * Run the eval suite: call Agent plan-stream for each task and record whether we got a valid plan.
 * Usage: node scripts/run-eval.js [baseUrl] [workspaceId]
 * Requires: CODE_COMPASS_EVAL_TOKEN env (or run in dev and pass cookie). Or use with a test user session.
 * Output: JSON results to stdout; use for CI or to compare models/prompts.
 */

const baseUrl = process.argv[2] || process.env.CODE_COMPASS_URL || "http://localhost:3000";
const workspaceId = process.argv[3] || process.env.CODE_COMPASS_WORKSPACE_ID;
const token = process.env.CODE_COMPASS_EVAL_TOKEN;

if (!workspaceId) {
  console.error("Usage: node scripts/run-eval.js [baseUrl] [workspaceId]");
  console.error("Or set CODE_COMPASS_WORKSPACE_ID and optionally CODE_COMPASS_URL, CODE_COMPASS_EVAL_TOKEN");
  process.exit(1);
}

const fs = require("fs");
const path = require("path");
const tasksPath = path.join(__dirname, "eval-tasks.json");
let tasks;
try {
  tasks = JSON.parse(fs.readFileSync(tasksPath, "utf8")).tasks;
} catch (e) {
  console.error("Failed to load eval-tasks.json:", e.message);
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function runTask(task) {
  const start = Date.now();
  let ok = false;
  let stepCount = 0;
  let error = null;
  try {
    const res = await fetch(`${baseUrl}/api/agent/plan-stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId,
        instruction: task.instruction,
        scopeMode: "normal",
      }),
    });
    if (!res.ok) {
      error = `HTTP ${res.status}: ${await res.text()}`;
      return { task: task.id, ok: false, error, latencyMs: Date.now() - start };
    }
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    let plan = null;
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, "");
      if (data === "[DONE]" || data === "") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.plan?.steps) {
          plan = parsed.plan;
          break;
        }
      } catch (_) {}
    }
    stepCount = plan?.steps?.length ?? 0;
    ok = task.expectPlanSteps ? stepCount > 0 : true;
  } catch (e) {
    error = e.message || String(e);
  }
  return {
    task: task.id,
    label: task.label,
    ok,
    stepCount,
    latencyMs: Date.now() - start,
    error: error || undefined,
  };
}

async function main() {
  const results = [];
  for (const task of tasks) {
    const result = await runTask(task);
    results.push(result);
    console.error(`${result.ok ? "✓" : "✗"} ${task.id} (${result.stepCount} steps) ${result.latencyMs}ms`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
