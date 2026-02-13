#!/usr/bin/env node
/**
 * Preflight: assert required scripts and binaries exist before dev/start/test.
 * Exits non-zero with remediation commands if missing.
 */

const fs = require("fs");
const path = require("path");

const REQUIRED_SCRIPTS = ["dev", "build", "start", "test", "lint"];
const REQUIRED_BINARIES = ["next", "vitest"];

function readPackageJson() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error("preflight: package.json not found");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
}

function findBinary(name) {
  const localBin = path.join(process.cwd(), "node_modules", ".bin", name);
  if (fs.existsSync(localBin)) return true;
  return false;
}

function main() {
  let failed = false;
  const pkg = readPackageJson();
  const scripts = pkg.scripts || {};

  const SCRIPT_DEFAULTS = { dev: "next dev", start: "next start", build: "next build", test: "vitest run", lint: "next lint" };
  for (const s of REQUIRED_SCRIPTS) {
    if (!scripts[s]) {
      console.error(`preflight: Missing npm script "${s}".`);
      console.error(`  Run: npm pkg set scripts.${s}='${SCRIPT_DEFAULTS[s] ?? "..."}'`);
      failed = true;
    }
  }

  for (const bin of REQUIRED_BINARIES) {
    if (!findBinary(bin)) {
      console.error(`preflight: binary "${bin}" not found in node_modules/.bin`);
      console.error(`  Remediation: npm install`);
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }
}

main();
