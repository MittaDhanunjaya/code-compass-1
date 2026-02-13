#!/usr/bin/env node
/**
 * Healthcheck for CI: validate ports, NODE_ENV, scripts, AI provider availability.
 * Exits 0 if all checks pass, non-zero otherwise.
 */

const net = require("net");
const fs = require("fs");
const path = require("path");

const VALID_NODE_ENV = ["development", "production", "test"];

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once("error", () => resolve(true))
      .once("listening", () => {
        server.close();
        resolve(false);
      })
      .listen(port, "127.0.0.1");
  });
}

async function checkPorts() {
  for (let p = 3000; p <= 3100; p++) {
    const busy = await isPortInUse(p);
    if (!busy) return { ok: true };
  }
  return { ok: false, msg: "No free port in 3000-3100" };
}

function checkNodeEnv() {
  const env = process.env.NODE_ENV || "";
  if (!env) return { ok: true }; // Empty is OK; dev/start scripts will normalize
  if (!VALID_NODE_ENV.includes(env)) {
    return { ok: false, msg: `NODE_ENV="${env}" invalid; expected development|production|test` };
  }
  return { ok: true };
}

function checkScripts() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return { ok: false, msg: "package.json not found" };
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const scripts = pkg.scripts || {};
  const required = ["dev", "build", "start", "test"];
  for (const s of required) {
    if (!scripts[s]) return { ok: false, msg: `Missing script: ${s}` };
  }
  return { ok: true };
}

function checkBinaries() {
  const bins = ["next", "vitest"];
  for (const b of bins) {
    const p = path.join(process.cwd(), "node_modules", ".bin", b);
    if (!fs.existsSync(p)) return { ok: false, msg: `Missing binary: ${b}` };
  }
  return { ok: true };
}

function checkAiProviderConfig() {
  const cfgPath = path.join(process.cwd(), "lib", "ai-providers.ts");
  if (!fs.existsSync(cfgPath)) {
    return { ok: false, msg: "lib/ai-providers.ts not found" };
  }
  return { ok: true };
}

async function main() {
  const checks = [
    { name: "ports", fn: () => checkPorts() },
    { name: "NODE_ENV", fn: () => Promise.resolve(checkNodeEnv()) },
    { name: "scripts", fn: () => Promise.resolve(checkScripts()) },
    { name: "binaries", fn: () => Promise.resolve(checkBinaries()) },
    { name: "ai-providers", fn: () => Promise.resolve(checkAiProviderConfig()) },
  ];

  let failed = false;
  for (const c of checks) {
    const r = await c.fn();
    if (!r.ok) {
      console.error(`healthcheck [${c.name}]: ${r.msg}`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  console.log("healthcheck: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
