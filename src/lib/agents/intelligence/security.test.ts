import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildAgentDomainIndex } from "./domain-index";
import { getAgentRunImpact } from "./impact";
import { getAgentRelationshipsForRun } from "./relationships";
import {
  getWorkspaceActivityCards,
  getWorkspaceAgentActivity,
} from "./workspace-activity";
import {
  withAgent,
  withArtifact,
  withEvent,
  withRun,
  withTabLink,
  withWorkItem,
} from "./__fixtures__/domain";

/**
 * The structural guard for the intelligence layer.
 *
 * `lib/agents/security.test.ts` scans only the files sitting *directly* in
 * `src/lib/agents/`, so a new subdirectory is not covered by it — the same
 * reason `spatial/` carries its own. This is that file for `intelligence/`,
 * and without it the whole layer would be unscanned.
 *
 * Three properties are enforced:
 *
 * 1. **No capability.** The layer derives; it cannot execute, read a file,
 *    open a socket, or reach a provider's local state.
 * 2. **No provider knowledge.** Generic intelligence must not import or
 *    branch on Claude Code, or any other provider, so a second adapter feeds
 *    the same models without touching this directory.
 * 3. **No leak.** Whatever the domain stores, what leaves here is the
 *    sanitised subset — no absolute path in a rendered field, no session id,
 *    no provider task id, no transcript.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const INTELLIGENCE_DIR = path.resolve(__dirname);

/**
 * Shipped sources only.
 *
 * Test files are excluded because this one necessarily contains every
 * forbidden string it looks for. `__fixtures__/` is excluded because it is
 * test-only scaffolding that deliberately calls domain mutators to build
 * states — and a separate assertion below proves no shipped file imports it,
 * so the exclusion cannot be used as a loophole.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__fixtures__" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = walk(INTELLIGENCE_DIR).map((file) => ({
  file: path.relative(ROOT, file),
  source: readFileSync(file, "utf8"),
}));

function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function specifiers(source: string): string[] {
  return [
    ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

describe("the intelligence layer has no capability of its own", () => {
  it("finds the files it is supposed to be checking", () => {
    // Guards against the walker silently matching nothing and the whole
    // suite passing vacuously.
    expect(sources.length).toBeGreaterThanOrEqual(6);
    const names = sources.map((s) => s.file).join(" ");
    expect(names).toContain("domain-index.ts");
    expect(names).toContain("run-summary.ts");
    expect(names).toContain("impact.ts");
    expect(names).toContain("workspace-activity.ts");
  });

  it("imports no process, shell, filesystem or network module", () => {
    const forbidden = [
      "child_process",
      "node:child_process",
      "fs",
      "node:fs",
      "fs/promises",
      "node:fs/promises",
      "node:os",
      "path",
      "node:path",
      "node:net",
      "node:http",
      "node:https",
      "node:worker_threads",
      "node:vm",
      "server-only",
    ];

    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const specifier of specifiers(source)) {
        if (forbidden.includes(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no execution or filesystem call shape", () => {
    const forbidden = [
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

    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const call of forbidden) {
        if (source.includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never mentions git, a terminal, or a shell in its code", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      const code = codeLines(source);
      for (const pattern of [
        /\bgit\s+(status|diff|log|commit|rev-parse|checkout)\b/,
        /\bchildProcess\b/,
        /\bmessagingSocketPath\b/,
      ]) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
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

  it("reads no provider's local state", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const pattern of [/~\/\.claude/, /\.claude[\\/]projects/, /homedir\(/]) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("touches no storage key — it derives, it does not persist", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const match of source.matchAll(/["'](tabdump:[^"']+)["']/g)) {
        offenders.push(`${file}: ${match[1]}`);
      }
      if (/localStorage|sessionStorage|indexedDB/.test(codeLines(source))) {
        offenders.push(`${file}: browser storage`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the intelligence layer cannot change anything", () => {
  it("imports no domain mutator", () => {
    // The domain's write operations. Importing one here would make a "read
    // model" able to rewrite the thing it reports on.
    const mutators = [
      "createAgent",
      "deleteAgent",
      "createRun",
      "updateRun",
      "transitionRun",
      "deleteRun",
      "addRunLink",
      "removeRunLink",
      "appendRunEvent",
      "clearRunEvents",
      "recordArtifactWork",
      "linkRunArtifact",
      "resolveWorkArtifact",
      "removeArtifactLinksForRun",
      "pruneOrphanedArtifacts",
      "createWorkItem",
      "updateWorkItem",
      "transitionWorkItem",
      "deleteWorkItem",
      "removeWorkItemsForRun",
      "saveAgentState",
      "loadAgentState",
    ];

    const offenders: string[] = [];
    for (const { file, source } of sources) {
      const imported = [...source.matchAll(/import\s*\{([^}]*)\}/g)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.replace(/\s+as\s+.*$/, "").trim());

      for (const name of imported) {
        if (mutators.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("declares no function that would act on an agent", () => {
    const forbidden = /\bexport\s+(?:async\s+)?function\s+(start|stop|kill|cancel|send|prompt|write|save|persist|execute|run)[A-Z]/;

    const offenders: string[] = [];
    for (const { file, source } of sources) {
      if (forbidden.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("imports no React — derivation is not a rendering concern", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const specifier of specifiers(source)) {
        if (specifier === "react" || specifier.startsWith("react/")) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("generic intelligence knows of no provider", () => {
  it("imports nothing from a provider subdirectory", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const specifier of specifiers(source)) {
        // Traffic is one-way: a provider feeds the domain, and the domain
        // feeds this. A single import in this direction would make the
        // generic model depend on one provider's shape.
        if (/claude-code|\/providers?\//.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("names no provider in its executable code", () => {
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      if (/\bclaude[-_]?code\b/i.test(codeLines(source))) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("is not reachable from test-only fixtures", () => {
    // `__fixtures__/` is excluded from the scan above, so it must not be
    // imported by anything shipped — otherwise the exclusion would be a hole.
    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const specifier of specifiers(source)) {
        if (specifier.includes("__fixtures__")) offenders.push(`${file}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("nothing sensitive reaches a derived model", () => {
  /** A run with a file, a tab, an event and a work item — every model populated. */
  function populated() {
    const base = withAgent();
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
    });
    let state = withWorkItem(run.state, {
      runId: run.runId,
      title: "Implement authentication",
      summary: "Sign-in route and tests",
      status: "active",
    }).state;
    state = withArtifact(state, { runId: run.runId, path: "src/auth.ts", role: "edited" }).state;
    state = withTabLink(state, { runId: run.runId, tabId: "t1", role: "context" });
    state = withEvent(state, { runId: run.runId, summary: "Edited auth.ts" });

    return { state, runId: run.runId };
  }

  it("exposes no absolute path in any rendered field", () => {
    const { state, runId } = populated();
    const index = buildAgentDomainIndex(state);

    const impact = getAgentRunImpact(index, runId)!;
    const activity = getWorkspaceAgentActivity(index, "w1");

    const renderedStrings = [
      ...impact.artifacts.map((entry) => entry.artifact.relativePath),
      ...impact.workItems.map((item) => item.title),
      ...impact.workItems.flatMap((item) => (item.summary ? [item.summary] : [])),
      ...activity.recentlyTouchedArtifacts.map((artifact) => artifact.relativePath),
      ...getWorkspaceActivityCards(index, "w1").map((card) => card.label),
    ];

    for (const value of renderedStrings) {
      expect(/^[A-Za-z]:[\\/]/.test(value), `${value} looks like a Windows path`).toBe(false);
      expect(value.startsWith("/home/")).toBe(false);
      expect(value.startsWith("/Users/")).toBe(false);
      expect(value.startsWith("\\\\")).toBe(false);
      expect(value).not.toContain("projects/demo");
    }
  });

  it("carries no session id or provider task id", () => {
    const { state, runId } = populated();
    const index = buildAgentDomainIndex(state);

    const models = [
      getAgentRunImpact(index, runId),
      getWorkspaceAgentActivity(index, "w1"),
      getWorkspaceActivityCards(index, "w1"),
      getAgentRelationshipsForRun(index, runId),
    ];

    for (const model of models) {
      const serialised = JSON.stringify(model);
      expect(serialised).not.toContain("externalId");
      expect(serialised).not.toContain("projectPath");
    }
  });

  it("exposes only the permitted fields on each reference type", () => {
    const { state, runId } = populated();
    const index = buildAgentDomainIndex(state);
    const impact = getAgentRunImpact(index, runId)!;
    const activity = getWorkspaceAgentActivity(index, "w1");

    const permittedWorkItem = new Set([
      "workItemId",
      "runId",
      "title",
      "summary",
      "status",
      "progress",
      "createdAt",
      "updatedAt",
      "startedAt",
      "completedAt",
    ]);
    for (const item of impact.workItems) {
      for (const key of Object.keys(item)) expect(permittedWorkItem).toContain(key);
    }

    const permittedRun = new Set([
      "runId",
      "agentId",
      "status",
      "title",
      "currentActivity",
      "createdAt",
      "updatedAt",
      "endedAt",
    ]);
    for (const run of activity.activeRuns) {
      for (const key of Object.keys(run)) expect(permittedRun).toContain(key);
    }

    for (const artifact of activity.recentlyTouchedArtifacts) {
      expect(Object.keys(artifact).sort()).toEqual([
        "artifactId",
        "relativePath",
        "updatedAt",
      ]);
    }
  });
});
