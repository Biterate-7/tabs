import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The visual layer's structural guards.
 *
 * Phase 18 adds a layer that is *about* providers — it names them, colours
 * them and draws them — sitting above a domain that must never learn one
 * exists. Three rules keep that arrangement from quietly eroding, and all
 * three fail silently if left to review:
 *
 *   1. **The visual layer cannot act.** It is presentation data. A single
 *      `fetch` or `child_process` here would turn a drawing system into
 *      something with reach.
 *   2. **Only the catalogue knows who the providers are.** That is what makes
 *      adding one a two-file change rather than a sweep through the UI, and
 *      it is the property brief §23 asks for.
 *   3. **It stores nothing.** The visual layer has no state of its own; the
 *      world's preferences live behind their own key in `world/persistence.ts`
 *      and nothing here may write anywhere.
 */

const VISUAL_DIR = path.resolve(__dirname);
const WORLD_DIR = path.resolve(__dirname, "../world");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const visualSources = walk(VISUAL_DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

const worldSources = walk(WORLD_DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

const allSources = [...visualSources, ...worldSources];

/** Code lines only — prose legitimately discusses what is *not* done. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("the visual and world layers cannot act on anything", () => {
  it("finds the files it is supposed to be checking", () => {
    // Guards against the walker silently matching nothing and the whole suite
    // passing vacuously.
    expect(visualSources.length).toBeGreaterThanOrEqual(6);
    expect(worldSources.length).toBeGreaterThanOrEqual(6);
    const names = allSources.map((entry) => entry.name);
    expect(names).toContain("catalog.ts");
    expect(names).toContain("registry.ts");
    expect(names).toContain("scene.ts");
  });

  it("imports no process, shell, filesystem or network module", () => {
    const forbidden = [
      "child_process",
      "node:child_process",
      "node:fs",
      "node:fs/promises",
      "fs/promises",
      "node:os",
      "node:net",
      "node:http",
      "node:https",
      "node:worker_threads",
      "node:vm",
      "server-only",
    ];

    const offenders: string[] = [];
    for (const { file, source } of allSources) {
      const specifiers = [
        ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
        ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (forbidden.includes(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no execution or network call shape", () => {
    const offenders: string[] = [];
    for (const { file, source } of allSources) {
      for (const call of [
        "spawnSync",
        "execFile",
        "execSync",
        "spawn(",
        "exec(",
        "eval(",
        "new Function(",
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "navigator.sendBeacon",
      ]) {
        if (codeOf(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("declares no member that would start, stop or drive an agent", () => {
    // The same omission `AgentAdapter` and `AgentConnector` are held to. A
    // visualisation of work must not become a control surface for it.
    const offenders: string[] = [];
    for (const { file, source } of allSources) {
      for (const pattern of [
        /\b(start|stop|kill|cancel|prompt|sendMessage)Run\b/,
        /\bcontrolAgent\b/,
        /\bdispatchTo(Agent|Run)\b/,
      ]) {
        if (pattern.test(codeOf(source))) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("only the catalogue knows which providers exist", () => {
  it("names a provider nowhere but the catalogue", () => {
    // The property that makes adding a provider a two-file change. If this
    // fails, some component has started branching on who the agent is, and
    // the next integration will have to edit it.
    const offenders: string[] = [];

    for (const { file, name, source } of allSources) {
      if (name === "catalog.ts") continue;
      const code = codeOf(source);
      for (const pattern of [
        /["']claude-code["']/,
        /["']openai-codex["']/,
        /["']gemini["']/,
        /["']grok["']/,
      ]) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("imports a provider mark only from the catalogue", () => {
    const offenders: string[] = [];

    for (const { file, name, source } of allSources) {
      if (name === "catalog.ts" || name === "marks.tsx") continue;
      // registry.ts legitimately imports the one generic fallback mark; what
      // must not happen is a module reaching for a *provider's* mark.
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/marks["']/g)) {
        const imported = match[1];
        if (/ClaudeCode|Codex|Gemini|Grok/.test(imported)) offenders.push(`${file}: ${imported}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the visual layer stores nothing", () => {
  it("touches no storage at all", () => {
    const offenders: string[] = [];
    for (const { file, source } of visualSources) {
      for (const call of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
        if (codeOf(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("confines the world layer to its own key", () => {
    const keys = new Set<string>();
    for (const { source } of worldSources) {
      for (const match of source.matchAll(/["'](tabdump:[^"']+)["']/g)) keys.add(match[1]);
    }

    expect([...keys]).toEqual(["tabdump:agent-world:v1"]);
  });

  it("registers that key as account-scoped", async () => {
    // One account's world configuration must be invisible to another signed
    // into the same browser, exactly as their workspaces already are.
    const { SCOPED_STORAGE_KEYS } = await import("@/lib/storage/namespace");
    expect(SCOPED_STORAGE_KEYS).toContain("tabdump:agent-world:v1");
  });

  it("never persists a run, an event or any observed content", () => {
    const { source } = worldSources.find((entry) => entry.name === "persistence.ts")!;
    const code = codeOf(source);
    for (const field of ["events", "runs", "workItems", "artifacts", "currentActivity"]) {
      expect(code).not.toContain(`${field}:`);
    }
  });
});

describe("the generic domain is still unaware of any of this", () => {
  it("is not imported by the agent domain", () => {
    // Traffic is one-way. The domain's own security test forbids it importing
    // a provider directory; this asserts the same for the visual layer, from
    // the other side.
    const domainDir = path.resolve(__dirname, "..");
    const domainFiles = readdirSync(domainDir).filter(
      (entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
    );

    const offenders: string[] = [];
    for (const entry of domainFiles) {
      const source = readFileSync(path.join(domainDir, entry), "utf8");
      if (/from\s+["'][^"']*(visual|world)\//.test(source)) offenders.push(entry);
    }

    expect(offenders).toEqual([]);
  });
});
