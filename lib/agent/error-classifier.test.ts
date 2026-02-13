import { describe, it, expect } from "vitest";
import { classifyErrorLog, getClassificationHint } from "./error-classifier";

describe("error-classifier", () => {
  describe("classifyErrorLog", () => {
    it("classifies port collision", () => {
      expect(classifyErrorLog("Error: listen EADDRINUSE: address already in use :::3000")).toBe("port_collision");
      expect(classifyErrorLog("Port 3000 is already in use")).toBe("port_collision");
    });

    it("classifies missing dependency", () => {
      expect(classifyErrorLog("Error: Cannot find module 'lodash'")).toBe("missing_dependency");
      expect(classifyErrorLog("ModuleNotFoundError: No module named 'flask'")).toBe("missing_dependency");
    });

    it("classifies script missing", () => {
      expect(classifyErrorLog("npm ERR! Missing script: \"dev\"")).toBe("script_missing");
      expect(classifyErrorLog("Unknown script \"start\"")).toBe("script_missing");
    });

    it("classifies syntax error", () => {
      expect(classifyErrorLog("SyntaxError: Unexpected token ')'")).toBe("syntax_error");
      expect(classifyErrorLog("SyntaxError: invalid syntax")).toBe("syntax_error");
    });

    it("classifies runtime exception", () => {
      const trace = `TypeError: Cannot read property 'x' of undefined
    at Component (app/page.tsx:42:10)
    at render`;
      expect(classifyErrorLog(trace)).toBe("runtime_exception");
    });

    it("returns unknown for short or empty input", () => {
      expect(classifyErrorLog("Error: ok")).toBe("unknown");
      expect(classifyErrorLog("")).toBe("unknown");
    });
  });

  describe("getClassificationHint", () => {
    it("returns hints for each classification", () => {
      expect(getClassificationHint("port_collision")).toContain("Port collision");
      expect(getClassificationHint("missing_dependency")).toContain("Missing dependency");
      expect(getClassificationHint("script_missing")).toContain("Script missing");
      expect(getClassificationHint("syntax_error")).toContain("Syntax error");
      expect(getClassificationHint("runtime_exception")).toContain("Runtime exception");
      expect(getClassificationHint("unknown")).toContain("Unknown");
    });
  });
});
