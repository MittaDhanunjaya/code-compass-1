/**
 * Tests for GET /api/version endpoint.
 */
import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/version", () => {
  it("returns version and app name", async () => {
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toHaveProperty("version");
    expect(typeof data.version).toBe("string");
    expect(data.version.length).toBeGreaterThan(0);
    expect(data).toHaveProperty("app");
    expect(data.app).toBe("code-compass");
  });

  it("returns semver-like version string", async () => {
    const res = await GET();
    const data = await res.json();
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
