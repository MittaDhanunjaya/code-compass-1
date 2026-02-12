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
      // Phase 3.4.7: Start at 4%, aim for 50% over time
      thresholds: {
        lines: 4,
        functions: 4,
        branches: 4,
        statements: 4,
      },
    },
  },
});
