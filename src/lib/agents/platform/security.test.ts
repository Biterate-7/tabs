import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPED_STORAGE_KEYS } from "@/lib/storage/namespace";
import { AGENT_ROSTER_KEY } from "./roster";

/**
 * The connector platform's guard suite (Phase J).
 *
 * The platform layer runs in the browser. It may describe agents, derive their
 * state and send typed commands; it may not execute, reach a filesystem, hold
 * a credential or speak to anything but the runtime's own command endpoint.
 */

const PLATFORM_DIR = path.resolve(__dirname);
const SRC_DIR = path.resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__fixtures__" ? [] : walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const sources = walk(PLATFORM_DIR).map((file) => ({
  name: path.basename(file),
  code: codeOf(readFileSync(file, "utf8")),
}));

describe("the platform layer", () => {
  it("found its files", () => {
    expect(sources.map((entry) => entry.name).sort()).toEqual(
      ["catalog.ts", "chat.ts", "connector.ts", "lifecycle.ts", "roster.ts"].sort()
    );
  });

  it("reaches no process, filesystem, adapter, launcher or SDK", () => {
    for (const { name, code } of sources) {
      for (const forbidden of [
        /child_process/,
        /node:fs/,
        /["']fs["']/,
        /agents\/launch\//,
        /control\/providers\//,
        /runtime\/host/,
        /runtime\/server/,
        // Imports only: the catalogue names packages in install text to show.
        /(from\s+|import\()["'](@anthropic-ai|@openai|@google|@modelcontextprotocol|@agentclientprotocol)/,
        /\bspawn\(|\bexec\(/,
      ]) {
        expect(`${name}: ${forbidden.test(code)}`).toBe(`${name}: false`);
      }
    }
  });

  it("posts nowhere of its own — the runtime client is the only transport", () => {
    for (const { name, code } of sources) {
      expect(`${name}: ${/\bfetch\(|XMLHttpRequest|WebSocket|EventSource/.test(code)}`).toBe(`${name}: false`);
    }
  });

  it("declares no credential field", () => {
    for (const { name, code } of sources) {
      for (const pattern of [/\bapiKey\b/i, /\baccessToken\b/i, /\brefreshToken\b/i, /\bpassword\b/i, /\bsecret\s*:/i, /\btoken\s*:/i]) {
        expect(`${name}: ${pattern.test(code)}`).toBe(`${name}: false`);
      }
    }
  });

  it("keeps its only storage key account-scoped", () => {
    expect(SCOPED_STORAGE_KEYS).toContain(AGENT_ROSTER_KEY);
    const keys = new Set<string>();
    for (const { code } of sources) for (const match of code.matchAll(/["'](tabdump:[^"']+)["']/g)) keys.add(match[1]);
    expect([...keys]).toEqual([AGENT_ROSTER_KEY]);
  });

  it("names providers in the catalogue only", () => {
    for (const { name, code } of sources) {
      if (name === "catalog.ts") continue;
      expect(`${name}: ${/["'](claude-code|openai-codex|gemini|grok)["']/.test(code)}`).toBe(`${name}: false`);
    }
  });

  it("never runs the install command it shows", () => {
    const components = walk(path.join(SRC_DIR, "components"));
    for (const file of components) {
      const code = codeOf(readFileSync(file, "utf8"));
      if (!code.includes("installCommand")) continue;
      // Rendered as text to copy, and nothing else touches it.
      expect(code).not.toMatch(/installCommand[^\n]*(send|fetch|post)\(/);
    }
  });
});
