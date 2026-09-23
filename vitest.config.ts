import { defineConfig } from "vitest/config";

// vite.config.ts sets `root` to the web client for the SPA build, which would
// also become the test root. Pin tests to the repository root instead.
export default defineConfig({
  test: {
    root: ".",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.smoke/**"],
    environment: "node",
  },
});
