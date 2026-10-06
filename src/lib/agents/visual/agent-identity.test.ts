import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConnectorCatalog } from "@/lib/agents/connectors/catalog";
import { PLATFORM_PROVIDERS, providerDisplayName } from "@/lib/agents/platform/catalog";
import { agentDisplayName as handoffAgentName } from "@/lib/agents/handoff/handoff";
import { agentVisualIdentity } from "./app-identities";
import { UNKNOWN_AGENT_NAME, agentDisplayName, agentIdentity } from "./identity";

/*
 * One agent, one name, one mark — wherever it appears.
 *
 * The session list, the session header, the timeline, a handoff, agent
 * history, the Action Inspector, Settings and the landing page's demo all ask
 * `agentIdentity` (or `agentDisplayName`), which reads the platform catalog.
 * These tests hold the catalogs to each other, and the surfaces to the one
 * lookup, so "Codex" in one place can never be "OpenAI / Codex" in the next.
 */

const SRC = join(process.cwd(), "src");

function sources(dir: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push({ path: relative(SRC, full).replace(/\\/g, "/"), source: readFileSync(full, "utf8") });
    }
  }
  return out;
}

/** Every surface that names an agent or says when something happened. */
const AGENT_SURFACES = [
  "components/agents",
  "components/command-centre",
  "components/marketing/demo",
  "components/settings/sections",
].flatMap((dir) => sources(join(SRC, dir)));

describe("the canonical agent identity", () => {
  it("gives the same provider the same presentation in every catalog", () => {
    const connectors = new Map(defaultConnectorCatalog().map((entry) => [entry.descriptor.provider, entry.descriptor]));
    for (const spec of PLATFORM_PROVIDERS) {
      const identity = agentIdentity(spec.provider);
      expect(identity.displayName).toBe(spec.displayName);
      expect(agentDisplayName(spec.provider)).toBe(spec.displayName);
      expect(handoffAgentName(spec.provider)).toBe(spec.displayName);
      expect(agentVisualIdentity(spec.provider).displayName).toBe(spec.displayName);
      expect(connectors.get(spec.provider)?.displayName).toBe(spec.displayName);
      expect(identity.icon).toBe(agentVisualIdentity(spec.provider).icon);
      expect(identity.brandName).toBe(spec.vendor);
      expect(identity.capabilities).toEqual({ chat: spec.chat, sessions: spec.sessions.available, features: spec.features });
      expect(identity.known).toBe(true);
    }
  });

  it("calls Codex 'Codex' — never 'OpenAI / Codex' — everywhere", () => {
    expect(agentDisplayName("openai-codex")).toBe("Codex");
    expect(agentIdentity("openai-codex").brandName).toBe("OpenAI");
    expect(defaultConnectorCatalog().map((entry) => entry.descriptor.displayName)).not.toContain("OpenAI / Codex");
  });

  it("has a short name for every provider, which is a name and never an id", () => {
    for (const spec of PLATFORM_PROVIDERS) {
      const { shortName } = agentIdentity(spec.provider);
      expect(shortName.length).toBeGreaterThan(0);
      expect(shortName).not.toBe(spec.provider);
    }
    expect(agentIdentity("custom").shortName).toBe("MCP");
  });

  it("never shows a provider id as a name — an unknown one is an unknown agent", () => {
    for (const id of ["openai-codex-v2", "claude-code-v2", "gemini_cli", "cursor-agent", "", undefined, null]) {
      expect(agentDisplayName(id)).toBe(UNKNOWN_AGENT_NAME);
      expect(providerDisplayName(id)).toBe(UNKNOWN_AGENT_NAME);
      expect(agentVisualIdentity(id).displayName === id && id).toBeFalsy();
      expect(agentIdentity(id).known).toBe(false);
      expect(agentIdentity(id).capabilities.sessions).toBe(false);
    }
  });
});

describe("every agent surface asks the one identity", () => {
  it("never names an agent from the catalog's raw entry, a provider id, or the visual registry directly", () => {
    const offenders: string[] = [];
    for (const { path, source } of AGENT_SURFACES) {
      // A name read off the catalog with the id as its fallback prints "openai-codex" one day.
      if (/displayName \?\? [\w.]*provider\b/.test(source)) offenders.push(`${path}: displayName ?? <provider id>`);
      // Names go through agentDisplayName; the visual registry is for marks.
      if (/agentVisualIdentity\([^)]*\)\.displayName/.test(source)) offenders.push(`${path}: agentVisualIdentity(...).displayName`);
      // The roster's stored name is a snapshot of an old catalog, not the agent's name.
      if (/\{agent\.name\}/.test(source) && /AgentIdentity\b/.test(source)) offenders.push(`${path}: roster agent.name`);
    }
    expect(offenders).toEqual([]);
  });

  it("formats every timestamp with the one time formatter", () => {
    const offenders = AGENT_SURFACES.filter(({ source }) =>
      /\.toLocale(Time|Date)String\(|\bago`|`\$\{[^}]+\}(m|h|d)`/.test(source)
    ).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe("a provider a host registered", () => {
  it("is named by its registration — still never by its id", async () => {
    const { registerAgentVisualIdentity, clearAgentVisualIdentities, FALLBACK_VISUAL_IDENTITY } = await import("./registry");
    const { resetAgentVisualIdentitySeeding } = await import("./app-identities");
    registerAgentVisualIdentity({ ...FALLBACK_VISUAL_IDENTITY, id: "acme-agent" as never, displayName: "Acme Agent" });
    try {
      expect(agentDisplayName("acme-agent")).toBe("Acme Agent");
      expect(agentIdentity("acme-agent")).toMatchObject({ displayName: "Acme Agent", known: true, capabilities: { sessions: false } });
      // A catalog provider is still the catalog's, whatever is registered.
      expect(agentDisplayName("openai-codex")).toBe("Codex");
    } finally {
      clearAgentVisualIdentities();
      resetAgentVisualIdentitySeeding();
    }
    expect(agentDisplayName("acme-agent")).toBe(UNKNOWN_AGENT_NAME);
  });
});
