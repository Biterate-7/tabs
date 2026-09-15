import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestObservation } from "@/lib/agents/adapter";
import { createAgent } from "@/lib/agents/registry";
import { emptyAgentState } from "@/lib/agents/types";
import { placeAgentScene } from "./placement";
import { buildAgentSpatialScene } from "./scene";

/**
 * Two guarantees, enforced mechanically.
 *
 * **Architectural**: the spatial layer consumes the agent domain and nothing
 * below it. It must not reach into a provider's internals, touch a
 * filesystem, or call an observation endpoint — the picture is drawn from
 * state the store already holds, by exactly one observer that lives elsewhere.
 *
 * **Data**: whatever a provider once knew, what reaches the canvas is the
 * sanitised domain state and only that. A leak here would put a prompt or a
 * shell command on screen.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const SPATIAL_DIR = path.resolve(__dirname);
const UI_FILES = [
  path.resolve(__dirname, "../../../hooks/use-agent-spatial.ts"),
  path.resolve(__dirname, "../../../components/graph/agent-node-renderer.ts"),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = [...walk(SPATIAL_DIR), ...UI_FILES].map((file) => ({
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

describe("the spatial layer stays above the provider", () => {
  it("finds the files it is supposed to be checking", () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
    const names = sources.map((s) => s.file).join(" ");
    expect(names).toContain("use-agent-spatial.ts");
    expect(names).toContain("agent-node-renderer.ts");
  });

  it("imports nothing from a provider's internals", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const specifier of specifiers(source)) {
        // The provider directory owns reading and parsing. The spatial layer
        // consumes the generic domain, so a single import in this direction
        // would couple the picture to one integration's data shapes.
        if (/claude-code/.test(specifier)) offenders.push(`${file}: ${specifier}`);
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

  it("touches no filesystem and opens no socket", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const specifier of specifiers(source)) {
        if (/^(node:)?(fs|fs\/promises|child_process|net|http|https|os)$/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
      for (const call of ["readFileSync", "createReadStream", "spawn(", "exec(", "eval("]) {
        if (codeLines(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("makes no request of its own — observation belongs to the observer", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const call of ["fetch(", "XMLHttpRequest", "WebSocket", "/api/"]) {
        if (codeLines(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("starts no polling loop of its own", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      // A second poller would duplicate the observer and double the work done
      // against the user's machine.
      for (const call of ["setInterval(", "requestAnimationFrame("]) {
        if (codeLines(source).includes(call)) offenders.push(`${file}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the spatial layer cannot change agent state", () => {
  it("imports no domain mutator", () => {
    const mutators = [
      "transitionRunStatus",
      "deleteRun",
      "deleteAgent",
      "createRun",
      "createAgent",
      "appendRunEvent",
      "recordArtifactWork",
      "addRunLink",
      "ingestObservation",
      "saveAgentState",
    ];
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const mutator of mutators) {
        if (new RegExp(`\\b${mutator}\\b`).test(codeLines(source))) {
          offenders.push(`${file}: ${mutator}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("nothing sensitive reaches the picture", () => {
  const hostile = {
    provider: "p",
    externalId: "sess-1",
    workspaceId: "wA",
    title: "Implement auth",
    activity: "Edited sidebar.tsx",
    artifacts: [
      { projectPath: "C:\\repo\\project", relativePath: "src/sidebar.tsx", role: "edited" as const },
    ],
  };

  function sceneFromObservation() {
    const agent = createAgent(emptyAgentState(), { provider: "p", name: "Claude Code" }, 1);
    if (!agent.ok) throw new Error("fixture failed");

    const ingested = ingestObservation(agent.state, {
      agentId: agent.agent.id,
      observation: hostile,
      now: 1,
    });
    if (!ingested.ok) throw new Error("fixture failed");

    const state = ingested.state;
    return buildAgentSpatialScene(state, {
      agents: state.agents,
      runs: state.runs,
      artifacts: state.artifacts,
      workspaceId: "wA",
      filter: "all",
      selectedId: null,
      now: 1,
    });
  }

  it("carries no prompt, reasoning, tool result or command", () => {
    const serialized = JSON.stringify(sceneFromObservation());

    for (const forbidden of [
      "thinking",
      "toolUseResult",
      "old_string",
      "new_string",
      "messagingSocketPath",
      "command",
      "prompt",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  /**
   * Fields a node puts on screen.
   *
   * The distinction this pins down: an artifact's `id` embeds its domain id,
   * which embeds the normalised project root — the identity exception Phase 13
   * documents, because a workspace may hold two projects with the same
   * relative path. That id is a key, never a caption. What a person can read
   * must be project-relative, and these are the fields a card draws.
   */
  const DISPLAYED_FIELDS = ["label", "detail", "relativePath", "provider", "activity", "status"];

  it("shows no absolute filesystem path in any field a card renders", () => {
    const scene = sceneFromObservation();

    for (const node of scene.nodes) {
      for (const field of DISPLAYED_FIELDS) {
        const value = (node as unknown as Record<string, unknown>)[field];
        if (typeof value !== "string") continue;
        expect(value).not.toMatch(/[A-Za-z]:[\\/]/);
        expect(value).not.toContain("/repo/");
      }
    }

    // The readable path is there, project-relative.
    const artifact = scene.nodes.find((node) => node.kind === "artifact");
    expect(artifact?.kind === "artifact" && artifact.relativePath).toBe("src/sidebar.tsx");
    expect(artifact?.kind === "artifact" && artifact.label).toBe("sidebar.tsx");
  });

  it("keeps the project root to identity, and never to a label", () => {
    const scene = sceneFromObservation();
    const artifact = scene.nodes.find((node) => node.kind === "artifact")!;

    // It is present in the key...
    expect(artifact.id).toContain("repo/project");
    // ...and absent from everything a person sees.
    expect(artifact.kind === "artifact" && artifact.label).not.toContain("repo");
    expect(artifact.kind === "artifact" && artifact.relativePath).not.toContain("repo");
  });

  it("uses positions keyed by id without those keys reaching a caption", () => {
    const scene = sceneFromObservation();
    const placed = placeAgentScene({ scene, pinned: {}, tabBounds: null });

    // Every placed key corresponds to a node, and every node's label is
    // independent of that key.
    for (const [id] of placed) {
      const node = scene.nodes.find((candidate) => candidate.id === id);
      expect(node).toBeDefined();
      expect(node!.label).not.toBe(id);
    }
  });

  it("exposes only the fields a card needs", () => {
    const scene = sceneFromObservation();
    const permitted = new Set([
      "kind",
      "id",
      "agentId",
      "runId",
      "artifactId",
      "label",
      "provider",
      "status",
      "activity",
      "relativePath",
      "tabCount",
      "artifactCount",
      "runCount",
      "activeRunCount",
      "totalRunCount",
      "updatedAt",
      "createdAt",
    ]);

    for (const node of scene.nodes) {
      for (const key of Object.keys(node)) expect(permitted).toContain(key);
    }
  });
});
