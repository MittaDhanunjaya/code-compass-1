/**
 * Token estimation tests.
 */

import { describe, it, expect } from "vitest";
import { estimateTokensFromTextAsync, estimateTokensFromChars } from "./token-estimate";

describe("token-estimate", () => {
  describe("estimateTokensFromTextAsync", () => {
    it("returns 0 for empty string", async () => {
      expect(await estimateTokensFromTextAsync("")).toBe(0);
    });

    it("returns token count when tokenizer available", async () => {
      const count = await estimateTokensFromTextAsync("Hello world");
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(5);
    });

    it("returns positive count for non-empty text", async () => {
      const longText = "x".repeat(100);
      const count = await estimateTokensFromTextAsync(longText);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(100);
    });
  });

  describe("estimateTokensFromChars", () => {
    it("estimates ~4 chars per token", () => {
      expect(estimateTokensFromChars(40)).toBe(10);
      expect(estimateTokensFromChars(0)).toBe(0);
    });
  });
});
