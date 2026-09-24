import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { launchEntryFor } from "./allowlist";
import { detectProviders } from "./detect";
import { createAcpProcessLauncher, realResolverFs } from "./process";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The real agents, when they are installed — opt-in.
 *
 * Set `TABDUMP_ACP_AGENT_PREFIX` to an npm prefix holding the real packages,
 * installed with the global layout a user's `npm install -g` produces:
 *
 *   npm install -g --prefix <dir> @google/gemini-cli @agentclientprotocol/codex-acp @xai-official/grok
 *
 * (On Windows keep `<dir>` short: codex-acp's bundled binary sits deep in its
 * package, and past 260 characters Windows reports it missing.)
 *
 * This suite then starts each real agent through the real launcher with the
 * allowlist's own entry, performs the real ACP handshake, asks the agent
 * whether it is signed in, and tries a real session. Skipped otherwise, like
 * the other `*.local.test.ts` suites: CI has no agents installed.
 *
 * The agents run with a **scratch home directory**, so they read no real
 * login and write nothing into the user's profile. Signed out is therefore
 * the expected answer — and the fact under test is that it is the *agent's*
 * answer, obtained the way the desktop app obtains it (Phase J.2).
 */

const PREFIX = process.env.TABDUMP_ACP_AGENT_PREFIX;
const run = PREFIX ? describe : describe.skip;

let home: string | undefined;

function environment(prefix: string): Record<string, string | undefined> {
  home ??= realpathSync(mkdtempSync(path.join(tmpdir(), "tabdump-acp-home-")));
  for (const dir of ["AppData/Roaming", "AppData/Local"]) mkdirSync(path.join(home, dir), { recursive: true });
  // A `--prefix` (non-global) install keeps its shims in node_modules/.bin;
  // the launcher looks for the global layout. A stand-in shim at the prefix
  // root is enough — its contents are never executed. A real one is kept.
  for (const shim of ["gemini.cmd", "codex-acp.cmd", "grok.cmd"]) {
    const file = path.join(prefix, shim);
    if (!existsSync(file)) writeFileSync(file, "@exit 1\r\n");
  }
  return {
    PATH: [prefix, path.dirname(process.execPath)].join(path.delimiter),
    PATHEXT: ".EXE;.CMD",
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
}

function adapterFor(provider: AgentProviderId) {
  const entry = launchEntryFor(provider)!.acp!;
  let launches = 0;
  const launcher = createAcpProcessLauncher({ provider, env: environment(PREFIX!) });
  const adapter = createAcpControlAdapter({
    provider,
    launch: (request) => {
      launches += 1;
      return launcher(request);
    },
    approval: entry.approval,
  });
  return { adapter, launches: () => launches };
}

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

/** What each real agent advertised when this was last verified — the interactive methods only. */
const EXPECTED_METHODS: Partial<Record<AgentProviderId, string[]>> = {
  gemini: ["oauth-personal"],
  "openai-codex": ["chat-gpt"],
  grok: ["grok.com"],
};

run("real ACP agents", () => {
  it("are detected as installed and launchable through the npm layout, with no path in the answer", () => {
    const detections = detectProviders({ env: environment(PREFIX!), platform: process.platform, fs: realResolverFs });
    for (const provider of ["gemini", "openai-codex", "grok"] as AgentProviderId[]) {
      expect(detections.find((entry) => entry.provider === provider)).toMatchObject({
        installed: true,
        launchable: true,
      });
    }
    expect(JSON.stringify(detections)).not.toContain(PREFIX!);
  });

  for (const provider of ["gemini", "openai-codex", "grok"] as AgentProviderId[]) {
    it(`${provider}: handshakes, says itself that it is signed out, and offers only its own login`, async () => {
      const { adapter } = adapterFor(provider);

      const connected = await adapter.connect();
      const auth = adapter.describeAuthentication();
      console.log(`[${provider}] connect:`, JSON.stringify(connected), "auth:", JSON.stringify(auth));

      expect(connected.ok).toBe(true);
      // The agent's own answer to session/new in a scratch home.
      expect(auth.state).toBe("required");
      // API-key methods can never work (the agent's environment carries no
      // key), so only the agent's interactive login is offered.
      expect(auth.methods.map((method) => method.id)).toEqual(EXPECTED_METHODS[provider]);

      await adapter.disconnect();
      expect(adapter.getConnectionStatus().kind).toBe("disconnected");
      adapter.dispose();
    }, 180_000);
  }

  for (const provider of ["gemini", "grok"] as AgentProviderId[]) {
    it(`${provider}: refuses a session as "sign in first", in the agent's words`, async () => {
      const { adapter } = adapterFor(provider);
      const created = await adapter.createSession({
        sessionId: `real-${provider}`,
        permissions: { scopes: [], grantedAt: Date.now() },
        attachments: [],
      });
      console.log(`[${provider}] session:`, JSON.stringify(created));
      expect(created).toMatchObject({ ok: false, error: { code: "configuration" } });
      adapter.dispose();
    }, 180_000);
  }

  it("openai-codex: is never given a session — refused before anything is launched", async () => {
    const { adapter, launches } = adapterFor("openai-codex");
    expect([...adapter.getCapabilities()]).toEqual([]);
    const created = await adapter.createSession({
      sessionId: "real-codex",
      permissions: { scopes: [], grantedAt: Date.now() },
      attachments: [],
    });
    expect(created).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(launches()).toBe(0);
    adapter.dispose();
  });
});
