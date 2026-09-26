import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestObservation } from "@/lib/agents/adapter";
import { addRunLink } from "@/lib/agents/links";
import { createAgent, findAgentByProvider } from "@/lib/agents/registry";
import { findRunByExternalId } from "@/lib/agents/runs";
import { getRunActivity, getRunEvents, getRunLinks } from "@/lib/agents/selectors";
import { emptyAgentState } from "@/lib/agents/types";
import { normalizeUrl } from "@/lib/tabs/normalize";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  defaultMappingState,
  findWorkspaceForProject,
  setProjectMapping,
} from "./mapping";
import { normalizeSession } from "./normalizer";
import { CLAUDE_CODE_AGENT_NAME, CLAUDE_CODE_PROVIDER } from "./types";
import type { AgentState } from "@/lib/agents/types";
import type { ProjectMappingState } from "./mapping";

/**
 * The whole pipeline, end to end, over a real filesystem:
 *
 *   transcript -> reader -> parser -> normalizer -> ingestObservation -> AgentRun
 *
 * Fixtures mirror the live Claude Code 2.1.270 layout and carry no real
 * content. The point is to prove the pieces fit: every other suite checks one
 * layer, and they can all pass while the seam between them is wrong.
 */

let home: string;
let previousConfigDir: string | undefined;

const SESSION = "b70abc10-f01a-48de-8d41-8ac936e8eff8";
const PROJECT_DIR = "C--Users-someone-project";
const CWD = "C:\\Users\\someone\\project";
const T0 = Date.parse("2026-09-15T08:00:00.000Z");

function sessionsDir() {
  return join(home, ".claude", "sessions");
}
function projectDir() {
  return join(home, ".claude", "projects", PROJECT_DIR);
}
function transcript() {
  return join(projectDir(), `${SESSION}.jsonl`);
}

function writeRegistry(status: string): void {
  writeFileSync(
    join(sessionsDir(), "9492.json"),
    JSON.stringify({
      pid: 9492,
      sessionId: SESSION,
      cwd: CWD,
      version: "2.1.270",
      messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-deadbeef",
      name: "project-c4",
      status,
      statusUpdatedAt: T0,
    })
  );
}

function toolLine(id: string, name: string, input: Record<string, unknown>, at = T0): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: `uuid-${id}`,
    timestamp: new Date(at).toISOString(),
    gitBranch: "main",
    message: { content: [{ type: "tool_use", id, name, input }] },
  })}\n`;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tabdump-cc-int-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(projectDir(), { recursive: true });
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  rmSync(home, { recursive: true, force: true });
});

/**
 * One poll of the whole pipeline.
 *
 * Mirrors what the route plus the observer hook do between them: sweep,
 * normalize, attach a workspace from the explicit mapping, ingest.
 */
async function poll(
  state: AgentState,
  agentId: string,
  mappings: ProjectMappingState,
  cursor: string
): Promise<{ state: AgentState; cursor: string; outcomes: string[] }> {
  const { sweepSessions } = await import("./reader");
  const sweep = await sweepSessions(decodeCursor(cursor), T0);

  let next = state;
  const outcomes: string[] = [];

  for (const result of sweep.results) {
    const observations = normalizeSession({
      session: result.session,
      records: result.records,
      now: T0,
    });

    for (const raw of observations) {
      const workspaceId = raw.projectKey
        ? findWorkspaceForProject(mappings, raw.projectKey)
        : undefined;
      const observation = workspaceId ? { ...raw, workspaceId } : raw;

      const ingested = ingestObservation(next, { agentId, observation, now: T0 });
      if (!ingested.ok) continue;
      next = ingested.state;
      outcomes.push(ingested.outcome);
    }
  }

  return { state: next, cursor: encodeCursor(sweep.results.map((r) => r.cursor)), outcomes };
}

function seedAgent(): { state: AgentState; agentId: string } {
  const created = createAgent(
    emptyAgentState(),
    { provider: CLAUDE_CODE_PROVIDER, name: CLAUDE_CODE_AGENT_NAME },
    T0
  );
  if (!created.ok) throw new Error("fixture failed");
  return { state: created.state, agentId: created.agent.id };
}

describe("discovery before mapping, attachment after", () => {
  it("runs the full lifecycle without ever guessing a workspace", async () => {
    writeRegistry("busy");
    writeFileSync(transcript(), toolLine("toolu_1", "Edit", { file_path: `${CWD}\\src\\a.ts` }));

    const seeded = seedAgent();
    let state = seeded.state;
    let mappings = defaultMappingState();
    let cursor = "";

    // 1. Discovered, but the project is not mapped: nothing is created.
    const first = await poll(state, seeded.agentId, mappings, cursor);
    state = first.state;
    cursor = first.cursor;

    expect(first.outcomes.every((outcome) => outcome === "unattached")).toBe(true);
    expect(state.runs).toEqual([]);

    // 2. The user maps the project. The very same session now attaches.
    mappings = setProjectMapping(mappings, CWD, "wA", T0);
    const second = await poll(state, seeded.agentId, mappings, cursor);
    state = second.state;
    cursor = second.cursor;

    const run = findRunByExternalId(state, seeded.agentId, SESSION);
    expect(run).toBeDefined();
    expect(run!.workspaceId).toBe("wA");
    expect(run!.status).toBe("working");
    expect(run!.title).toBe("project-c4");

    // 3. New work appears and is observed incrementally.
    appendFileSync(transcript(), toolLine("toolu_2", "Bash", { command: "SECRET", description: "Run the tests" }));
    const third = await poll(state, seeded.agentId, mappings, cursor);
    state = third.state;
    cursor = third.cursor;

    expect(getRunActivity(state, run!.id)).toBe("Run the tests");
    expect(JSON.stringify(state)).not.toContain("SECRET");

    // 4. Polling again with nothing new adds no events and no runs.
    const eventsBefore = getRunEvents(state, run!.id).length;
    const fourth = await poll(state, seeded.agentId, mappings, cursor);
    state = fourth.state;
    cursor = fourth.cursor;

    expect(getRunEvents(state, run!.id)).toHaveLength(eventsBefore);
    expect(state.runs).toHaveLength(1);

    // 5. The session goes idle.
    writeRegistry("idle");
    const fifth = await poll(state, seeded.agentId, mappings, cursor);
    state = fifth.state;

    expect(findRunByExternalId(state, seeded.agentId, SESSION)!.status).toBe("waiting");
    // Metadata learned earlier is still there.
    expect(findRunByExternalId(state, seeded.agentId, SESSION)!.title).toBe("project-c4");
  });

  it("creates exactly one run and one agent across many polls", async () => {
    writeRegistry("busy");
    writeFileSync(transcript(), toolLine("toolu_1", "Edit", { file_path: "a.ts" }));

    const seeded = seedAgent();
    let state = seeded.state;
    const mappings = setProjectMapping(defaultMappingState(), CWD, "wA", T0);
    let cursor = "";

    for (let i = 0; i < 5; i += 1) {
      const result = await poll(state, seeded.agentId, mappings, cursor);
      state = result.state;
      cursor = result.cursor;
    }

    expect(state.agents).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(findAgentByProvider(state, CLAUDE_CODE_PROVIDER)).toBeDefined();
  });

  it("does not duplicate events when the same records are re-read", async () => {
    writeRegistry("busy");
    writeFileSync(
      transcript(),
      toolLine("toolu_1", "Edit", { file_path: "a.ts" }) +
        toolLine("toolu_2", "Read", { file_path: "b.ts" })
    );

    const seeded = seedAgent();
    const mappings = setProjectMapping(defaultMappingState(), CWD, "wA", T0);

    // Every poll reuses the empty cursor, so the reader hands back the same
    // records each time. Dedupe by tool_use id is what keeps history correct.
    let state = seeded.state;
    for (let i = 0; i < 4; i += 1) {
      const result = await poll(state, seeded.agentId, mappings, "");
      state = result.state;
    }

    const run = findRunByExternalId(state, seeded.agentId, SESSION)!;
    const activity = getRunEvents(state, run.id).filter((event) => event.kind === "activity");

    expect(activity.map((event) => event.summary)).toEqual(["Edited a.ts", "Inspected b.ts"]);
  });
});

describe("terminal lifecycle", () => {
  it("treats an explicit release artifact as cancellation", async () => {
    writeRegistry("busy");
    writeFileSync(transcript(), toolLine("toolu_1", "Edit", { file_path: "a.ts" }));

    const seeded = seedAgent();
    const mappings = setProjectMapping(defaultMappingState(), CWD, "wA", T0);

    const first = await poll(seeded.state, seeded.agentId, mappings, "");
    expect(findRunByExternalId(first.state, seeded.agentId, SESSION)!.status).toBe("working");

    writeFileSync(
      join(projectDir(), `${SESSION}.desktop-released.json`),
      JSON.stringify({ v: 1, releasedAt: new Date(T0).toISOString(), reason: "delete" })
    );

    const second = await poll(first.state, seeded.agentId, mappings, first.cursor);
    const run = findRunByExternalId(second.state, seeded.agentId, SESSION)!;

    expect(run.status).toBe("cancelled");
    expect(run.endedAt).toBeDefined();
  });

  it("leaves a run untouched when its session simply vanishes", async () => {
    writeRegistry("busy");
    writeFileSync(transcript(), toolLine("toolu_1", "Edit", { file_path: "a.ts" }));

    const seeded = seedAgent();
    const mappings = setProjectMapping(defaultMappingState(), CWD, "wA", T0);

    const first = await poll(seeded.state, seeded.agentId, mappings, "");
    const before = findRunByExternalId(first.state, seeded.agentId, SESSION)!;
    expect(before.status).toBe("working");

    // The process exits. No sidecar is written — the real observed behaviour.
    rmSync(join(sessionsDir(), "9492.json"));
    const second = await poll(first.state, seeded.agentId, mappings, first.cursor);
    const after = findRunByExternalId(second.state, seeded.agentId, SESSION)!;

    // Conservative on purpose: disappearance cannot distinguish success from
    // failure from cancellation, so nothing is asserted about it.
    expect(after.status).toBe("working");
    expect(after.endedAt).toBeUndefined();
  });
});

describe("url context linking", () => {
  it("links an observed url to an existing tab, exactly", async () => {
    writeRegistry("busy");
    writeFileSync(
      transcript(),
      toolLine("toolu_1", "mcp__Claude_Browser__navigate", {
        url: "https://example.com/docs?utm_source=x",
      })
    );

    const seeded = seedAgent();
    const mappings = setProjectMapping(defaultMappingState(), CWD, "wA", T0);
    const polled = await poll(seeded.state, seeded.agentId, mappings, "");

    const run = findRunByExternalId(polled.state, seeded.agentId, SESSION)!;

    // The workspace already holds this page, normalized the Hubble way.
    const saved = normalizeUrl(new URL("https://example.com/docs"));
    const observedUrl = "https://example.com/docs?utm_source=x";
    expect(normalizeUrl(new URL(observedUrl))).toBe(saved);

    const linked = addRunLink(
      polled.state,
      { runId: run.id, tabId: "tab-docs", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!linked.ok) throw new Error("expected success");

    expect(getRunLinks(linked.state, run.id)).toHaveLength(1);
    expect(getRunLinks(linked.state, run.id)[0].role).toBe("context");
  });

  it("cannot link a tab from another workspace", async () => {
    writeRegistry("busy");
    writeFileSync(transcript(), toolLine("toolu_1", "Edit", { file_path: "a.ts" }));

    const seeded = seedAgent();
    const mappings = setProjectMapping(defaultMappingState(), CWD, "wA", T0);
    const polled = await poll(seeded.state, seeded.agentId, mappings, "");
    const run = findRunByExternalId(polled.state, seeded.agentId, SESSION)!;

    expect(
      addRunLink(
        polled.state,
        { runId: run.id, tabId: "tab-elsewhere", role: "context", tabWorkspaceId: "wB" },
        T0
      )
    ).toEqual({ ok: false, reason: "cross-workspace" });
  });
});

describe("what reaches the domain", () => {
  it("stores no prompt, reasoning, command or tool result", async () => {
    writeRegistry("busy");
    writeFileSync(
      transcript(),
      `${JSON.stringify({
        type: "assistant",
        uuid: "u1",
        timestamp: new Date(T0).toISOString(),
        message: {
          content: [
            { type: "thinking", thinking: "PRIVATE-REASONING" },
            { type: "text", text: "MODEL-PROSE" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "echo SECRET-CREDENTIAL", description: "Print a value" },
            },
          ],
        },
        toolUseResult: { stdout: "SECRET-OUTPUT" },
      })}\n` +
        `${JSON.stringify({ type: "user", uuid: "u2", message: { content: "USER-PROMPT-TEXT" } })}\n`
    );

    const seeded = seedAgent();
    const mappings = setProjectMapping(defaultMappingState(), CWD, "wA", T0);
    const polled = await poll(seeded.state, seeded.agentId, mappings, "");

    const serialized = JSON.stringify(polled.state);
    for (const secret of [
      "PRIVATE-REASONING",
      "MODEL-PROSE",
      "SECRET-CREDENTIAL",
      "SECRET-OUTPUT",
      "USER-PROMPT-TEXT",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // The safe summary did make it through.
    const run = findRunByExternalId(polled.state, seeded.agentId, SESSION)!;
    expect(getRunActivity(polled.state, run.id)).toBe("Print a value");
  });
});
