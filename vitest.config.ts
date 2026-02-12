import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["lib/**/*.test.ts", "app/api/**/*.test.ts", "services/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["lib/**/*.ts", "app/api/**/*.ts", "services/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/node_modules/**"],
      // Phase 9.1.4: Raised to 10% after adding chain-of-thought, errors, scope, retry-handler tests.
      // Target 70% for core logic (Phase 9); incremental improvements.
      thresholds: {
        lines: 10,
        functions: 10,
        branches: 7,
        statements: 10,
      },
    },
  },
});
