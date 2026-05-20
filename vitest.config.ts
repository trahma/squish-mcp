import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test file gets a fresh in-memory/temp DB; isolate to avoid
    // cross-file interference on shared singletons.
    pool: "forks",
    testTimeout: 10_000,
  },
});
