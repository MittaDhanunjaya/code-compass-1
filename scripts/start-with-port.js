#!/usr/bin/env node
/**
 * Start Next.js production server with port collision handling.
 */

const path = require("path");
const { spawn } = require("child_process");

async function runPortFinder() {
  const { execSync } = require("child_process");
  const portArgs = process.argv.slice(2).filter((a) => a.startsWith("--port="));
  const cmd = portArgs.length ? `node scripts/port-finder.js ${portArgs.join(" ")}` : "node scripts/port-finder.js";
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function main() {
  process.env.__ENV_GUARD_CMD = "start";
  require(path.join(__dirname, "env-guard.js"));
  require(path.join(__dirname, "preflight.js"));

  const defaultPort = process.env.PORT || "3000";
  runPortFinder().then((port) => {
    if (port !== defaultPort) {
      console.log(`Port ${defaultPort} busy. Server started on ${port}.`);
    }
    process.env.PORT = port;
    const child = spawn("npx", ["next", "start", "-p", port], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, PORT: port },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

main();
