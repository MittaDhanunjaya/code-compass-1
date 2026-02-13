#!/usr/bin/env node
/**
 * NODE_ENV guardrail at startup.
 * Validates NODE_ENV; if invalid, logs warning and auto-normalizes.
 * For dev: development; for start: production.
 */

const VALID = ["development", "production", "test"];

function main() {
  const cmd = process.env.__ENV_GUARD_CMD || process.argv[2] || "dev";
  const current = process.env.NODE_ENV || "";

  if (VALID.includes(current)) {
    return;
  }

  const target = cmd === "start" ? "production" : "development";
  const msg = current
    ? `NODE_ENV="${current}" is invalid. Expected: development | production | test. Using "${target}" for "${cmd}".`
    : `NODE_ENV not set. Using "${target}" for "${cmd}".`;

  console.warn(`[env-guard] ${msg}`);
  process.env.NODE_ENV = target;
}

main();
