/**
 * Phase 9.1.2: Tests for lib/errors (error categorization and user-friendly messages).
 */

import { describe, it, expect } from "vitest";
import {
  getUserFriendlyMessage,
  classifyError,
  parseApiErrorForDisplay,
  AI_TEMPORARILY_UNAVAILABLE,
  isAiTemporarilyUnavailableError,
  errorResponse,
  type ErrorCategory,
} from "./errors";

describe("lib/errors", () => {
  describe("getUserFriendlyMessage", () => {
    it("returns auth message for auth category", () => {
      expect(getUserFriendlyMessage("auth")).toBe("Please re-authenticate to continue.");
    });

    it("returns rate limit message with retry minutes", () => {
      expect(getUserFriendlyMessage("rate_limit", { retryAfterSeconds: 60 })).toBe(
        "Please wait 1 minute before trying again."
      );
      expect(getUserFriendlyMessage("rate_limit", { retryAfterSeconds: 120 })).toBe(
        "Please wait 2 minutes before trying again."
      );
      expect(getUserFriendlyMessage("rate_limit")).toBe(
        "Please wait 1 minute before trying again."
      );
    });

    it("returns network message for network category", () => {
      expect(getUserFriendlyMessage("network")).toBe(
        "Check your connection and try again."
      );
    });

    it("returns validation message for validation category", () => {
      expect(getUserFriendlyMessage("validation")).toBe(
        "Please check your input and try again."
      );
    });

    it("returns generic message for unknown category", () => {
      expect(getUserFriendlyMessage("unknown")).toBe(
        "An unexpected error occurred. Please try again."
      );
    });
  });

  describe("classifyError", () => {
    it("classifies 401 as auth", () => {
      expect(classifyError(401)).toBe("auth");
    });

    it("classifies 429 as rate_limit", () => {
      expect(classifyError(429)).toBe("rate_limit");
    });

    it("classifies 400 and 422 as validation", () => {
      expect(classifyError(400)).toBe("validation");
      expect(classifyError(422)).toBe("validation");
    });

    it("classifies 408, 503, 504 as network", () => {
      expect(classifyError(408)).toBe("network");
      expect(classifyError(503)).toBe("network");
      expect(classifyError(504)).toBe("network");
    });

    it("classifies 500 as unknown", () => {
      expect(classifyError(500)).toBe("unknown");
    });
  });

  describe("parseApiErrorForDisplay", () => {
    it("returns user-friendly message for 401", () => {
      expect(parseApiErrorForDisplay("Unauthorized", 401)).toBe(
        "Please re-authenticate to continue."
      );
    });

    it("returns user-friendly message for 429 with retryAfter", () => {
      expect(parseApiErrorForDisplay("Too many requests", 429, 90)).toBe(
        "Please wait 2 minutes before trying again."
      );
    });

    it("returns user-friendly message for network errors", () => {
      expect(parseApiErrorForDisplay("Timeout", 504)).toBe(
        "Check your connection and try again."
      );
    });

    it("returns original message when statusCode is null", () => {
      expect(parseApiErrorForDisplay("Custom error", undefined)).toBe("Custom error");
    });

    it("returns original message for unknown status", () => {
      expect(parseApiErrorForDisplay("Special error", 418)).toBe("Special error");
    });
  });

  describe("AI_TEMPORARILY_UNAVAILABLE", () => {
    it("isAiTemporarilyUnavailableError returns true for errors with code", () => {
      expect(isAiTemporarilyUnavailableError({ code: AI_TEMPORARILY_UNAVAILABLE })).toBe(true);
      expect(isAiTemporarilyUnavailableError(new Error("x"))).toBe(false);
    });

    it("errorResponse returns 503 with code for AI_TEMPORARILY_UNAVAILABLE", async () => {
      const err = new Error("All AI providers failed") as Error & { code?: string };
      err.code = AI_TEMPORARILY_UNAVAILABLE;
      const res = errorResponse(err);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe(AI_TEMPORARILY_UNAVAILABLE);
      expect(body.error).toContain("temporarily unavailable");
    });
  });
});
