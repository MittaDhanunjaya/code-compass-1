/**
 * Tests for execution error classification.
 */

import { describe, it, expect } from "vitest";
import { classifyExecutionError } from "./execution-error-classifier";

describe("classifyExecutionError", () => {
  it("returns MODULE_NOT_FOUND for Cannot find module", () => {
    const r = classifyExecutionError(
      "Error: Cannot find module 'vitest'\n    at src/app.test.ts:2:1",
      "",
      1
    );
    expect(r.errorType).toBe("MODULE_NOT_FOUND");
    expect(r.missingDependency).toBe("vitest");
    expect(r.failingFile).toBeTruthy();
  });

  it("returns COMMAND_NOT_FOUND for exit code 127", () => {
    const r = classifyExecutionError("command not found", "", 127);
    expect(r.errorType).toBe("COMMAND_NOT_FOUND");
  });

  it("returns SYNTAX_ERROR for SyntaxError", () => {
    const r = classifyExecutionError("SyntaxError: unexpected token at src/app.ts:5", "", 1);
    expect(r.errorType).toBe("SYNTAX_ERROR");
  });

  it("returns PERMISSION_ERROR for EACCES", () => {
    const r = classifyExecutionError("Error: EACCES: permission denied", "", 1);
    expect(r.errorType).toBe("PERMISSION_ERROR");
  });

  it("returns CONFIG_ERROR for tsconfig", () => {
    const r = classifyExecutionError("error TS6059: File is not under 'rootDir'. tsconfig.json", "", 1);
    expect(r.errorType).toBe("CONFIG_ERROR");
  });
});
