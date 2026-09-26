import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A structural guard, in the same spirit as no-tauri-in-web.test.ts.
 *
 * The agent domain represents work done by an external coding agent. The
 * distance between "represents" and "performs" is the entire safety story of
 * this feature, and it is not self-enforcing: a single `child_process` import
 * added later — to "just check git branch", or to "just stop a stuck run" —
 * would silently turn Hubble into a remote-execution surface driven by
 * whatever can write to its state.
 *
 * So the rule is enforced mechanically rather than by review: nothing under
 * src/lib/agents/ may reach a process, a shell, the filesystem, or git.
 *
 * Test files are excluded from the scan — this one necessarily contains every
 * forbidden string it looks for.
 */

const AGENT_DIR = path.resolve(__dirname);
const HOOK = path.resolve(__dirname, "../../hooks/use-agent-store.ts");

/**
 * The GENERIC domain only — the files directly in src/lib/agents/, not the
 * provider subdirectories beneath it.
 *
 * A provider adapter is precisely where reading a provider's local files
 * belongs, so holding one to "never import node:fs" would be holding it to
 * the wrong rule. Each provider directory carries its own, stricter guard
 * (see claude-code/security.test.ts, which additionally forbids writes, the
 * control channel and client-supplied paths).
 *
 * What the generic domain must never do is know a provider exists at all,
 * which the dependency-direction test below pins.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return [];
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const shipped = [...walk(AGENT_DIR), HOOK];
const sources = shipped.map((file) => ({
  file: path.relative(path.resolve(__dirname, "../../.."), file),
  source: readFileSync(file, "utf8"),
}));

/**
 * Modules that would give the domain the ability to execute something, reach
 * the filesystem, or talk to a network peer.
 */
const FORBIDDEN_MODULES = [
  "child_process",
  "node:child_process",
  "node:fs",
  "node:fs/promises",
  "fs/promises",
  "node:os",
  "node:path",
  "node:net",
  "node:http",
  "node:https",
  "node:worker_threads",
  "node:vm",
  "server-only",
];

/** Call shapes that mean execution, regardless of where they were imported from. */
const FORBIDDEN_CALLS = [
  "spawnSync",
  "execFile",
  "execSync",
  "spawn(",
  "exec(",
  "fork(",
  "readFileSync",
  "writeFileSync",
  "createReadStream",
  "eval(",
  "new Function(",
];

describe("the agent domain cannot execute anything", () => {
  it("finds the files it is supposed to be checking", () => {
    // Guards against the walker silently matching nothing and the whole
    // suite passing vacuously.
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.map((s) => s.file).join(" ")).toContain("use-agent-store.ts");
  });

  it("imports no process, shell, filesystem or network module", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      const specifiers = [
        ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
        ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (FORBIDDEN_MODULES.includes(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no process-execution or filesystem call shape", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const call of FORBIDDEN_CALLS) {
        if (source.includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never mentions git, a terminal, or a shell", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      // Comments legitimately discuss what is NOT done ("never obtained by
      // running git"), so only code lines are checked.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

      for (const pattern of [/\bgit\s+(status|diff|log|commit|rev-parse)\b/, /\bchildProcess\b/]) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the agent domain reads no local agent state", () => {
  it("never reaches for a provider's own files", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const pattern of [/~\/\.claude/, /\.claude[\\/]projects/, /\.claude[\\/]sessions/, /homedir\(/]) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("touches only its own storage key", () => {
    const keys = new Set<string>();

    for (const { source } of sources) {
      for (const match of source.matchAll(/["'](tabdump:[^"']+)["']/g)) keys.add(match[1]);
    }

    expect([...keys]).toEqual(["tabdump:agents:v1"]);
  });

  it("makes no network request", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const call of ["fetch(", "XMLHttpRequest", "WebSocket", "navigator.sendBeacon"]) {
        if (source.includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the generic domain knows of no provider", () => {
  it("imports nothing from a provider subdirectory", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      const specifiers = [
        ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
        ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        // Traffic is one-way: a provider directory imports the domain, never
        // the reverse. A single import in this direction would make the
        // generic model depend on the shape of one provider's data.
        if (/claude-code|\/providers?\//.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("names no provider in its executable code", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      // Prose may use a provider as an example — types.ts does, to say what an
      // Agent *is*. What must not exist is a provider name the code branches
      // on, which would be special-casing one integration inside the model
      // that exists to be agnostic of all of them.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

      if (/\bclaude[-_]?code\b/i.test(code)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

describe("the adapter seam offers no control surface", () => {
  it("declares no method that would act on an agent", () => {
    const adapterSource = readFileSync(path.join(AGENT_DIR, "adapter.ts"), "utf8");
    const declared = [...adapterSource.matchAll(/^\s{2}(?:readonly\s+)?(\w+)[(:]/gm)].map(
      (match) => match[1]
    );

    // Whatever the interface grows, it may not grow one of these.
    for (const forbidden of ["start", "stop", "kill", "cancel", "exec", "prompt", "sendMessage", "write"]) {
      expect(declared).not.toContain(forbidden);
    }
  });
});
