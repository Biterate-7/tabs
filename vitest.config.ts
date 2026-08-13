import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Running test files in parallel worker threads under this machine's
    // concurrent dev-server/browser-tooling load starves real-timer-based
    // userEvent waits and causes intermittent timeouts. Sequential file
    // execution trades some speed for reliable, non-flaky runs.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
