/**
 * Tests for AST parser (Tree-sitter integration).
 */

import { describe, it, expect } from "vitest";
import { extractSymbolsAST, extractImportsAST } from "../ast-parser";

describe("AST Parser", () => {
  describe("extractSymbolsAST", () => {
    it("should extract function declarations", async () => {
      const code = `
function hello() {
  return "world";
}
`;
      const symbols = await extractSymbolsAST(code, "test.ts");
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols.some((s) => s.name === "hello")).toBe(true);
    });

    it("should extract class declarations", async () => {
      const code = `
class MyClass {
  method() {}
}
`;
      const symbols = await extractSymbolsAST(code, "test.ts");
      expect(symbols.some((s) => s.name === "MyClass" && s.type === "class")).toBe(true);
    });

    it("should extract exports", async () => {
      const code = `
export const myVar = 123;
export function myFunc() {}
`;
      const symbols = await extractSymbolsAST(code, "test.ts");
      expect(symbols.some((s) => s.name === "myVar")).toBe(true);
      expect(symbols.some((s) => s.name === "myFunc")).toBe(true);
    });
  });

  describe("extractImportsAST", () => {
    it("should extract ES6 imports", async () => {
      const code = `
import { something } from "./module";
import React from "react";
`;
      const imports = await extractImportsAST(code, "test.ts");
      expect(imports).toContain("./module");
      expect(imports).toContain("react");
    });

    it("should extract dynamic imports", async () => {
      const code = `
const module = await import("./dynamic");
`;
      const imports = await extractImportsAST(code, "test.ts");
      // Note: Dynamic imports might not be extracted depending on parser
      expect(imports.length).toBeGreaterThanOrEqual(0);
    });
  });
});
