#!/usr/bin/env node
/**
 * Cross-platform port detection for Next.js dev/start.
 * If default port (3000) is busy, finds first free port in 3001-3100.
 * Works on macOS, Linux, Windows.
 */

const net = require("net");

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer().once("error", (err) => {
      resolve(err.code === "EADDRINUSE");
    }).once("listening", () => {
      server.close();
      resolve(false);
    }).listen(port, "127.0.0.1");
  });
}

async function findFreePort(startPort, endPort) {
  for (let port = startPort; port <= endPort; port++) {
    const inUse = await isPortInUse(port);
    if (!inUse) return port;
  }
  return null;
}

function parsePortFromArgs() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    const m = arg.match(/^--port=(.+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function main() {
  const cliPort = parsePortFromArgs();
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  const defaultPort = cliPort ?? envPort ?? 3000;
  const inUse = await isPortInUse(defaultPort);
  const port = inUse ? await findFreePort(3001, 3999) : defaultPort;
  if (!port) {
    console.error("No free port found in range 3001-3999");
    process.exit(1);
  }
  if (inUse && port !== defaultPort) {
    console.log(`Port ${defaultPort} busy. Server started on ${port}.`);
  }
  process.stdout.write(String(port));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
