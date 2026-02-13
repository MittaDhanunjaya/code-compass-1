/**
 * Tests for terminal error classification.
 */

import { describe, it, expect } from "vitest";
import { classifyTerminalError } from "./terminal-error-classifier";

describe("classifyTerminalError", () => {
  it("returns DEPENDENCY_ERROR when npm missing or module not found", () => {
    const r = classifyTerminalError("npm run test", "npm ERR! code MODULE_NOT_FOUND\nCannot find module 'xyz'", "");
    expect(r.type).toBe("DEPENDENCY_ERROR");
    expect(r.hint).toContain("DEPENDENCY_ERROR");
    expect(r.hint).toContain("dependencies");
  });

  it("returns DEPENDENCY_ERROR for exit code 127 (command not found)", () => {
    const r = classifyTerminalError("npm test", "command not found", "", 127);
    expect(r.type).toBe("DEPENDENCY_ERROR");
  });

  it("returns SYNTAX_ERROR for syntax errors", () => {
    const r = classifyTerminalError("node app.js", "SyntaxError: unexpected token", "");
    expect(r.type).toBe("SYNTAX_ERROR");
  });

  it("returns CONFIG_ERROR for tsconfig/package.json issues", () => {
    const r = classifyTerminalError("tsc", "error TS6059: File is not under 'rootDir'. tsconfig.json compilerOptions", "");
    expect(r.type).toBe("CONFIG_ERROR");
  });

  it("returns RUNTIME_ERROR for TypeError", () => {
    const r = classifyTerminalError("node app.js", "TypeError: Cannot read property 'x' of undefined", "");
    expect(r.type).toBe("RUNTIME_ERROR");
  });

  it("returns PERMISSION_ERROR for EACCES", () => {
    const r = classifyTerminalError("chmod", "Error: EACCES: permission denied", "");
    expect(r.type).toBe("PERMISSION_ERROR");
  });
});
