import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Performance and quality benchmarks for conversation intelligence — kept
 * out of the normal suite (they take minutes, and the quality run downloads
 * a local embedding model once). Run with:
 *
 *   npx vitest run --config vitest.perf.config.mts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.perf.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
