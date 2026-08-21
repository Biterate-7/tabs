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
      // `server-only` relies on Next's bundler swapping in a no-op for the
      // server compilation graph; outside of Next's build it always throws,
      // so tests need their own no-op stand-in to exercise server-side code.
      "server-only": path.resolve(__dirname, "./src/lib/titles/server/server-only-stub.ts"),
    },
  },
});
