import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createAcpProcessLauncher } from "./process";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The real agents, when they are installed — opt-in.
 *
 * Set `TABDUMP_ACP_AGENT_PREFIX` to an npm prefix holding the real packages
 * (`npm install --prefix <dir> @google/gemini-cli @agentclientprotocol/codex-acp`)
 * and this suite starts each real agent through the real launcher, performs
 * the real ACP handshake, and tries a real session. Skipped otherwise, like
 * the other `*.local.test.ts` suites: CI has no agents installed.
 *
 * The agents run with a **scratch home directory**, so they read no real
 * login and write nothing into the user's profile. Without a login, a session
 * is expected to be refused as "sign in first" — which is itself the fact
 * under test: that TabDump reads the agent's own answer rather than guessing.
 */

const PREFIX = process.env.TABDUMP_ACP_AGENT_PREFIX;
const run = PREFIX ? describe : describe.skip;

let home: string | undefined;

function environment(prefix: string): Record<string, string | undefined> {
  home ??= realpathSync(mkdtempSync(path.join(tmpdir(), "tabdump-acp-home-")));
  for (const dir of ["AppData/Roaming", "AppData/Local"]) mkdirSync(path.join(home, dir), { recursive: true });
  // The global-install layout the launcher looks for: a shim at the prefix
  // root beside node_modules. Its contents are never executed.
  for (const shim of ["gemini.cmd", "codex-acp.cmd"]) writeFileSync(path.join(prefix, shim), "@exit 1\r\n");
  return {
    PATH: [prefix, path.dirname(process.execPath)].join(path.delimiter),
    PATHEXT: ".EXE;.CMD",
    SystemRoot: process.env.SystemRoot,
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
}

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

run("real ACP agents", () => {
  for (const provider of ["gemini", "openai-codex"] as AgentProviderId[]) {
    it(`${provider}: handshakes over ACP and reports its own sign-in methods`, async () => {
      const adapter = createAcpControlAdapter({
        provider,
        launch: createAcpProcessLauncher({ provider, env: environment(PREFIX!) }),
      });

      const connected = await adapter.connect();
      const auth = adapter.describeAuthentication();
      console.log(`[${provider}] connect:`, JSON.stringify(connected), "auth:", JSON.stringify(auth));

      expect(connected.ok).toBe(true);
      expect(auth.methods.length).toBeGreaterThan(0);

      const created = await adapter.createSession({
        sessionId: `real-${provider}`,
        permissions: { scopes: [], grantedAt: Date.now() },
        attachments: [],
      });
      console.log(`[${provider}] session/new:`, JSON.stringify(created), "auth now:", adapter.describeAuthentication().state);
      // Signed out in a scratch home: either the agent refuses as "sign in
      // first", or — for an agent that defers auth — it opens a session.
      if (!created.ok) expect(created.error.code).toBe("configuration");

      adapter.dispose();
    }, 120_000);
  }
});
