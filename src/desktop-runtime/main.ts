/**
 * The desktop agent runtime's entry point (Phase J.1).
 *
 * Bundled by `scripts/build-agent-runtime.mjs` into one file that the Tauri
 * shell runs as a sidecar with the Node binary it ships. Everything it does is
 * in `lib/agents/runtime/desktop.ts`; this file only owns the process edges:
 *
 *   - **stdin** carries one JSON object per line from the shell:
 *     `{"id":7,"request":<runtime request>}` or `{"id":8,"shutdown":true}`.
 *   - **stdout** carries exactly one JSON line per request back:
 *     `{"id":7,"response":<runtime result>}`. Nothing else is ever written to
 *     it — `console.*` is pointed at stderr first, so a library that logs
 *     cannot corrupt the protocol.
 *   - **the environment** is read here and nowhere else in the sidecar, and
 *     the shell has already reduced it to an allowlist before starting us.
 *
 * When stdin closes — the app quit, crashed, or was killed — every agent
 * session is ended and every agent process released before this exits. The
 * shell additionally places this process in a Windows job object that kills
 * the whole tree with it, so a crash cannot strand an agent either way.
 */
import { createInterface } from "node:readline";
import { createDesktopRuntime } from "@/lib/agents/runtime/desktop";
import { handleDesktopLine } from "@/lib/agents/runtime/desktop-protocol";

for (const method of ["log", "info", "warn", "debug"] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

const runtime = createDesktopRuntime({
  env: process.env,
  // A literal import, so the bundler includes the SDK in the sidecar.
  loadClaudeSdk: () => import("@anthropic-ai/claude-agent-sdk"),
});

let closing = false;

async function shutdown(code: number): Promise<never> {
  if (!closing) {
    closing = true;
    await runtime.dispose().catch(() => {});
  }
  process.exit(code);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  void handleDesktopLine(runtime, line).then((reply) => {
    if (reply.out !== null) process.stdout.write(`${reply.out}\n`);
    if (reply.shutdown) void shutdown(0);
  });
});

lines.on("close", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("uncaughtException", () => void shutdown(1));
