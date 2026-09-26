import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_PROVIDERS, platformProvider } from "./catalog";
import { connectionPhase, phaseSentence, sessionAvailability, stepFor } from "./lifecycle";
import { PROVIDER_LAUNCH_TABLE } from "@/lib/agents/launch/allowlist";
import { TABDUMP_MCP_TOOLS } from "@/lib/mcp/server";
import type { ProviderConnectionView, ProviderDetection } from "@/lib/agents/runtime/protocol";

/**
 * The provider registry (Phase J.2).
 *
 * The browser's registry and the server's launch allowlist describe the same
 * agents from two sides of a boundary neither may import across at runtime.
 * These tests are where the two are held to each other, so a provider cannot
 * be "available" in the UI and refused on the server, or the reverse.
 */

const gemini = platformProvider("gemini")!;
const codex = platformProvider("openai-codex")!;
const grok = platformProvider("grok")!;
const claude = platformProvider("claude-code")!;
const custom = platformProvider("custom")!;

const INSTALLED: ProviderDetection = { provider: "gemini", installed: true, transport: "acp", launchable: true };

function reached(authentication: ProviderConnectionView["authentication"]): ProviderConnectionView {
  return {
    provider: "gemini",
    connection: "connected",
    available: true,
    authentication,
    capabilities: ["create_session", "message"],
    nativeSignIn: true,
    authMethods: [],
  };
}

describe("the registry and the launch allowlist agree", () => {
  it("has a launch entry for every agent Hubble runs, and none for the one it never starts", () => {
    for (const entry of PLATFORM_PROVIDERS) {
      const launch = PROVIDER_LAUNCH_TABLE.find((candidate) => candidate.provider === entry.provider);
      if (entry.transport === "mcp") expect(launch).toBeUndefined();
      else expect(launch).toBeDefined();
      expect(Boolean(launch?.acp)).toBe(entry.transport === "acp");
    }
  });

  it("refuses sessions in the UI exactly where the server does, in the same words", () => {
    for (const entry of PROVIDER_LAUNCH_TABLE) {
      const approval = entry.acp?.approval;
      if (!approval) continue;
      const registry = platformProvider(entry.provider)!.sessions;
      if (approval.kind === "unavailable") {
        expect(registry).toEqual({ available: false, reason: approval.reason });
      } else {
        expect(registry).toEqual({ available: true });
      }
    }
  });

  it("never tells anyone to pipe a script into a shell", () => {
    for (const entry of PLATFORM_PROVIDERS) {
      if (!entry.installCommand) continue;
      expect(entry.installCommand).toMatch(/^npm install -g @[a-z-]+\/[a-z-]+$/);
    }
  });
});

describe("the custom agent explains exactly what it connects", () => {
  it("is an MCP client Hubble never starts, offered only where there is an MCP server", () => {
    expect(custom.transport).toBe("mcp");
    expect(custom.chat).toBe(false);
    expect(custom.surfaces).toEqual(["web"]);
    expect(custom.unavailableOn?.desktop).toMatch(/desktop app does not run one/);
  });

  it("describes the MCP server's actual tools, all of which are read-only", () => {
    // If a tool is added to the server, this sentence has to be revisited.
    expect([...TABDUMP_MCP_TOOLS]).toEqual([
      "list_workspaces",
      "get_workspace",
      "get_tabs",
      "get_collection",
      "get_tab_graph",
      "list_agent_projects",
      "list_agent_sessions",
    ]);
    const fullSource = readFileSync(path.resolve(__dirname, "../../mcp/server.ts"), "utf8");
    // Account mode — what a custom agent connects to — is everything before
    // the session-mode section (Phase J.3), which a custom agent never reaches.
    const marker = fullSource.indexOf("Session mode (Phase J.3)");
    expect(marker).toBeGreaterThan(0);
    const serverSource = fullSource.slice(0, marker);
    const registrations = serverSource.match(/registerTool\(/g) ?? [];
    const readOnly = serverSource.match(/annotations:\s*READ_ONLY/g) ?? [];
    expect(registrations.length).toBe(TABDUMP_MCP_TOOLS.length);
    expect(readOnly.length).toBe(registrations.length);

    // Session mode has exactly four tools that are not read-only: create,
    // rename and add tabs to a collection (J.4), and propose a plan of those
    // same changes (J.5). None writes: each only proposes, which asks the
    // user every time. preview_workspace_plan is read-only; it changes nothing.
    const sessionSource = fullSource.slice(marker);
    const sessionRegistrations = sessionSource.match(/registerTool\(/g) ?? [];
    const sessionReadOnly = sessionSource.match(/annotations:\s*READ_ONLY/g) ?? [];
    expect(sessionRegistrations.length - sessionReadOnly.length).toBe(4);
    expect(sessionSource.match(/scope\.requestPlan\(/g)).toHaveLength(1);
    expect(sessionSource).toMatch(/"propose_workspace_plan",[\s\S]*?annotations: WRITE_TOOL/);
    expect(sessionSource).toMatch(/const WRITE_TOOL = \{ readOnlyHint: false, destructiveHint: false/);
    for (const write of ["create_collection", "rename_collection", "add_tabs_to_collection"]) {
      expect(sessionSource).toContain(`propose("${write}", { kind: "${write}"`);
    }
    expect(sessionSource.match(/scope\.requestChange\(/g)).toHaveLength(1);

    expect(custom.explainer).toEqual([
      expect.stringMatching(/Hubble never starts it/),
      expect.stringMatching(/revoke/),
      expect.stringMatching(/workspaces, tabs, collections and tab graph/),
      expect.stringMatching(/cannot change anything/),
    ]);
  });

  it("has no field anywhere in the registry through which a program could be named", () => {
    const source = readFileSync(path.resolve(__dirname, "catalog.ts"), "utf8");
    expect(source).not.toMatch(/\b(command|executable|argv|args|path|shell)\s*:/);
  });
});

describe("authentication state comes from the runtime (Phase J.2)", () => {
  const base = { provider: gemini, executable: true, local: true, detection: INSTALLED };

  it("shows what the agent said: signed in, sign-in required, or could not be verified", () => {
    expect(connectionPhase({ ...base, status: reached("authenticated") })).toBe("awaiting_approval");
    expect(connectionPhase({ ...base, status: reached("required") })).toBe("sign_in_required");
    expect(connectionPhase({ ...base, status: reached("unknown") })).toBe("unverified");
    expect(stepFor("unverified")).toBe("sign_in");
  });

  it("never reads an unverified sign-in as connected, even for an approved agent", () => {
    expect(
      connectionPhase({ ...base, status: reached("unknown"), approvedScopes: ["read_workspace"] })
    ).toBe("unverified");
  });

  it("says connecting while the agent is being asked", () => {
    expect(connectionPhase({ ...base, connecting: true })).toBe("connecting");
    expect(stepFor("connecting")).toBe("sign_in");
  });

  it("says authenticating, separately, while the agent's own sign-in waits on the person", () => {
    expect(connectionPhase({ ...base, authenticating: true })).toBe("authenticating");
    expect(phaseSentence(gemini, "authenticating")).toBe("Waiting for you to finish signing in to Gemini CLI…");
    expect(stepFor("authenticating")).toBe("sign_in");
  });

  it("does not call an approved agent connected until this runtime has reached it", () => {
    const approved = { ...base, approvedScopes: ["read_workspace"] as const };
    expect(connectionPhase({ ...approved, status: { ...reached("unknown"), connection: "disconnected" } })).toBe(
      "disconnected"
    );
    expect(connectionPhase({ ...approved, status: reached("authenticated") })).toBe("connected");
  });
});

describe("failure states read the same for every provider", () => {
  it("uses the sentences a person can act on", () => {
    expect(phaseSentence(codex, "not_installed")).toBe("Codex is not installed.");
    expect(phaseSentence(gemini, "sign_in_required", { installed: true })).toBe(
      "Gemini CLI is installed but not authenticated."
    );
    expect(phaseSentence(grok, "runtime_unavailable")).toMatch(/^Grok Build is unavailable on this runtime\./);
    expect(phaseSentence(gemini, "unverified")).toBe("Authentication could not be verified.");
    expect(phaseSentence(custom, "runtime_unavailable", { surface: "desktop" })).toBe(custom.unavailableOn!.desktop);
  });

  it("puts no path, no command and no provider text in any sentence", () => {
    for (const provider of PLATFORM_PROVIDERS) {
      for (const phase of [
        "runtime_unavailable",
        "not_installed",
        "needs_adapter",
        "detected",
        "connecting",
        "sign_in_required",
        "unverified",
        "awaiting_approval",
        "connected",
        "error",
        "unknown",
      ] as const) {
        const sentence = phaseSentence(provider, phase, { surface: "desktop", installed: true });
        expect(sentence).not.toMatch(/[\\/]|npm |--|\.exe|\.json/);
      }
    }
  });
});

describe("surfaces", () => {
  it("does not offer a custom MCP agent in the desktop app, which runs no MCP server", () => {
    expect(connectionPhase({ provider: custom, surface: "desktop", executable: true, local: true })).toBe(
      "runtime_unavailable"
    );
    expect(connectionPhase({ provider: custom, surface: "web", executable: false, local: false, mcpTokenIssued: false })).toBe(
      "sign_in_required"
    );
  });

  it("offers every agent Hubble runs on both surfaces", () => {
    for (const provider of [claude, codex, gemini, grok]) expect(provider.surfaces).toEqual(["web", "desktop"]);
  });
});

describe("session availability", () => {
  it("is the registry's refusal first, with its reason", () => {
    expect(sessionAvailability(codex, undefined)).toEqual(codex.sessions);
    expect(sessionAvailability(gemini, undefined)).toEqual({ available: true });
  });

  it("then the runtime's: an adapter that declares no create_session cannot be given one", () => {
    expect(sessionAvailability(gemini, { ...reached("authenticated"), capabilities: [] })).toMatchObject({
      available: false,
    });
  });
});

describe("no component branches on a provider", () => {
  it("keeps provider ids out of the command centre's components and the platform hook", () => {
    const roots = [
      path.resolve(__dirname, "../../../components/command-centre"),
      path.resolve(__dirname, "../../../hooks/use-agent-platform.ts"),
    ];
    const files = roots.flatMap((root) => (statSync(root).isDirectory() ? walk(root) : [root]));
    const offenders = files.filter((file) => {
      const code = readFileSync(file, "utf8");
      return /(===|!==)\s*"(claude-code|openai-codex|gemini|grok|custom)"/.test(code);
    });
    expect(offenders.map((file) => path.basename(file))).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}
