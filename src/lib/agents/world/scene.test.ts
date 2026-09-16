import { describe, expect, it } from "vitest";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import { addRunLink } from "@/lib/agents/links";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus } from "@/lib/agents/runs";
import { RECENT_RUN_WINDOW_MS } from "@/lib/agents/spatial/types";
import { emptyAgentState } from "@/lib/agents/types";
import { createWorkItem, transitionWorkItem } from "@/lib/agents/work-items";
import { buildWorldScene, handoffsForCharacter, idleCharacterId, runCharacterId } from "./scene";
import { DEFAULT_AGENT_WORLD_SETTINGS } from "./settings";
import { ZONE_FOR_STATE } from "./types";
import type { AgentRunStatus, AgentState } from "@/lib/agents/types";
import type { AgentWorldSettings } from "./settings";

const T0 = 1_700_000_000_000;
const PROJECT = "C:\\repo\\project";

function ok<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`fixture failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

function seed(provider = "claude-code", name = "Claude Code") {
  const agent = ok(createAgent(emptyAgentState(), { provider, name }, T0));
  return { state: agent.state, agentId: agent.agent.id };
}

function addRun(
  state: AgentState,
  agentId: string,
  workspaceId: string,
  title: string,
  createdAt = T0
) {
  const run = ok(createRun(state, { agentId, workspaceId, title }, createdAt));
  return { state: run.state, runId: run.run.id };
}

function setStatus(state: AgentState, runId: string, status: AgentRunStatus, at = T0 + 10) {
  return ok(transitionRunStatus(state, runId, status, at)).state;
}

function withArtifact(state: AgentState, runId: string, path: string, at = T0) {
  return ok(recordArtifactWork(state, { runId, projectPath: PROJECT, path, role: "edited" }, at))
    .state;
}

function withTab(
  state: AgentState,
  runId: string,
  tabId: string,
  role: "context" | "produced",
  at = T0,
  workspaceId = "wA"
) {
  return ok(addRunLink(state, { runId, tabId, role, tabWorkspaceId: workspaceId }, at)).state;
}

function withWorkItem(state: AgentState, runId: string, title: string, at = T0) {
  const result = ok(createWorkItem(state, { runId, title }, at));
  return { state: result.state, itemId: result.workItem.id };
}

function build(state: AgentState, over: Partial<AgentWorldSettings> = {}, now = T0 + 1000, extra: Partial<Parameters<typeof buildWorldScene>[0]> = {}) {
  return buildWorldScene({
    index: buildAgentDomainIndex(state),
    workspaceId: "wA",
    settings: { ...DEFAULT_AGENT_WORLD_SETTINGS, ...over },
    now,
    ...extra,
  });
}

describe("an empty world", () => {
  it("draws nobody when nothing has happened and nothing is connected", () => {
    const scene = build(emptyAgentState());
    expect(scene.characters).toEqual([]);
    expect(scene.handoffs).toEqual([]);
    expect(scene.hiddenCharacterCount).toBe(0);
  });

  it("still names a theme, so the stage has something to render", () => {
    expect(build(emptyAgentState()).theme.id).toBe(DEFAULT_AGENT_WORLD_SETTINGS.themeId);
  });

  it("draws nobody for a workspace that does not exist", () => {
    const { state, agentId } = seed();
    const withRun = addRun(state, agentId, "wA", "Work");
    const scene = buildWorldScene({
      index: buildAgentDomainIndex(withRun.state),
      workspaceId: "",
      settings: DEFAULT_AGENT_WORLD_SETTINGS,
      now: T0,
    });
    expect(scene.characters).toEqual([]);
  });
});

describe("agents entering and leaving", () => {
  it("draws one character per live run, not one per agent", () => {
    // Three concurrent sessions of the same agent are three workers, which is
    // what they are. A world of agents would show one figure however much was
    // happening.
    const { state, agentId } = seed();
    let current = addRun(state, agentId, "wA", "First").state;
    current = addRun(current, agentId, "wA", "Second", T0 + 1).state;
    current = addRun(current, agentId, "wA", "Third", T0 + 2).state;

    expect(build(current).characters).toHaveLength(3);
  });

  it("gives a character an id derived from its run", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");
    expect(build(withRun).characters[0].id).toBe(runCharacterId(runId));
  });

  it("removes a finished run once it is no longer recent", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");
    const done = setStatus(withRun, runId, "completed", T0 + 10);

    expect(build(done, {}, T0 + 1000).characters).toHaveLength(1);
    expect(build(done, {}, T0 + RECENT_RUN_WINDOW_MS + 60_000).characters).toHaveLength(0);
  });

  it("removes a finished run immediately when the user asked it to leave", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");
    const done = setStatus(withRun, runId, "completed", T0 + 10);

    expect(build(done, { showCompleted: false }).characters).toHaveLength(0);
  });

  it("keeps a live run whatever the finished-run setting says", () => {
    const { state, agentId } = seed();
    const { state: withRun } = addRun(state, agentId, "wA", "Work");
    expect(build(withRun, { showCompleted: false }).characters).toHaveLength(1);
  });
});

describe("staying inside its workspace", () => {
  it("draws only the runs of the workspace it was asked about", () => {
    const { state, agentId } = seed();
    let current = addRun(state, agentId, "wA", "Here").state;
    current = addRun(current, agentId, "wB", "Elsewhere", T0 + 1).state;

    const scene = build(current);
    expect(scene.characters).toHaveLength(1);
    expect(scene.characters[0].title).toBe("Here");
  });
});

describe("what a character is doing", () => {
  it("is working when the run named a task", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");
    const { state: withItem, itemId } = withWorkItem(withRun, runId, "Implement auth");
    const active = ok(transitionWorkItem(withItem, itemId, "active", T0 + 5)).state;

    const character = build(active).characters[0];
    expect(character.state).toBe("working");
    expect(character.activity).toBe("Implement auth");
  });

  it("is thinking when the run is live and has named nothing", () => {
    const { state, agentId } = seed();
    const { state: withRun } = addRun(state, agentId, "wA", "Work");

    const character = build(withRun).characters[0];
    expect(character.state).toBe("thinking");
    expect(character.activity).toBeUndefined();
  });

  it("reads as finished, and stands in the done zone, once the run completes", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");
    const done = setStatus(withRun, runId, "completed", T0 + 10);

    const character = build(done).characters[0];
    expect(character.state).toBe("success");
    expect(character.zone).toBe("done");
  });

  it("reads as needing attention, in the attention zone, when the run fails", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");
    const failed = setStatus(withRun, runId, "failed", T0 + 10);

    const character = build(failed).characters[0];
    expect(character.state).toBe("error");
    expect(character.zone).toBe("attention");
  });

  it("puts every character in the zone its state maps to", () => {
    const { state, agentId } = seed();
    let current = state;
    for (const [index, status] of (["working", "waiting", "completed", "failed"] as const).entries()) {
      const added = addRun(current, agentId, "wA", `Run ${index}`, T0 + index);
      current = status === "working" ? added.state : setStatus(added.state, added.runId, status, T0 + 20);
    }

    for (const character of build(current).characters) {
      expect(character.zone).toBe(ZONE_FOR_STATE[character.state]);
    }
  });

  it("reports progress only from real work items", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");

    // No items: no ratio at all, rather than 0/0.
    expect(build(withRun).characters[0].progress).toBeUndefined();

    const first = withWorkItem(withRun, runId, "One");
    const second = withWorkItem(first.state, runId, "Two", T0 + 1);
    // pending -> active -> completed: the domain refuses to jump straight to
    // a terminal status, and the fixture has to respect that.
    const started = ok(transitionWorkItem(second.state, first.itemId, "active", T0 + 4)).state;
    const done = ok(transitionWorkItem(started, first.itemId, "completed", T0 + 5)).state;

    expect(build(done).characters[0].progress).toEqual({ completed: 1, total: 2 });
  });

  it("carries the run's own agent name rather than re-deriving it", () => {
    const { state, agentId } = seed("some-future-agent", "Future Agent");
    const { state: withRun } = addRun(state, agentId, "wA", "Work");
    expect(build(withRun).characters[0].agentName).toBe("Future Agent");
  });
});

describe("agents sharing work", () => {
  function twoRunsSharingAFile(secondStatus?: AgentRunStatus) {
    const { state, agentId } = seed();
    const first = addRun(state, agentId, "wA", "First", T0);
    const second = addRun(first.state, agentId, "wA", "Second", T0 + 1);

    let current = withArtifact(second.state, first.runId, "src/app/page.tsx", T0 + 10);
    current = withArtifact(current, second.runId, "src/app/page.tsx", T0 + 20);
    if (secondStatus) current = setStatus(current, second.runId, secondStatus, T0 + 30);

    return { state: current, firstRunId: first.runId, secondRunId: second.runId };
  }

  it("draws a line between two runs that touched the same file", () => {
    const { state, firstRunId, secondRunId } = twoRunsSharingAFile();
    const scene = build(state);

    expect(scene.handoffs).toHaveLength(1);
    expect(scene.handoffs[0].fromCharacterId).toBe(runCharacterId(firstRunId));
    expect(scene.handoffs[0].toCharacterId).toBe(runCharacterId(secondRunId));
  });

  it("puts both of them in the exchange zone while both are live", () => {
    const { state } = twoRunsSharingAFile();
    for (const character of build(state).characters) {
      expect(character.state).toBe("communicating");
      expect(character.zone).toBe("exchange");
    }
  });

  it("stops calling it a handoff the moment one side finishes", () => {
    // Self-limiting, with no timer deciding when a conversation is over. A
    // live run that once shared a file with a finished one is working.
    const { state } = twoRunsSharingAFile("completed");
    const states = build(state).characters.map((character) => character.state);
    expect(states).not.toContain("communicating");
  });

  it("still draws the line to a finished partner, so the relationship is not lost", () => {
    const { state } = twoRunsSharingAFile("completed");
    expect(build(state).handoffs).toHaveLength(1);
  });

  it("draws a line for a tab one run produced and another read", () => {
    const { state, agentId } = seed();
    const first = addRun(state, agentId, "wA", "First", T0);
    const second = addRun(first.state, agentId, "wA", "Second", T0 + 1);

    let current = withTab(second.state, first.runId, "t1", "produced", T0 + 10);
    current = withTab(current, second.runId, "t1", "context", T0 + 20);

    const scene = build(current, {}, T0 + 1000, {
      tabTitles: new Map([["t1", "Release notes"]]),
    });
    expect(scene.handoffs).toHaveLength(1);
    expect(scene.handoffs[0].label).toBe("passed Release notes");
    expect(scene.handoffs[0].via).toBe("tab");
  });

  it("states a character's handoffs in words, with direction", () => {
    const { state, firstRunId, secondRunId } = twoRunsSharingAFile();
    const scene = build(state);

    // Found by id rather than by position: the index groups a workspace's
    // runs newest-first, so the array order is not creation order.
    const outgoing = handoffsForCharacter(scene, runCharacterId(firstRunId));
    const incoming = handoffsForCharacter(scene, runCharacterId(secondRunId));

    expect(outgoing.map((entry) => entry.direction)).toContain("to");
    expect(incoming.map((entry) => entry.direction)).toContain("from");
    expect(outgoing[0].withName.length).toBeGreaterThan(0);
  });

  it("finds no handoffs for a character that shared nothing", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Alone");
    const scene = build(withRun);
    expect(handoffsForCharacter(scene, runCharacterId(runId))).toEqual([]);
  });
});

describe("connected agents with nothing to do", () => {
  const idle = [{ provider: "gemini", displayName: "Gemini" }];

  it("stands them in the arrival zone when the user wants them visible", () => {
    const scene = build(emptyAgentState(), { showIdleAgents: true }, T0, {
      idleProviders: idle,
    });

    expect(scene.characters).toHaveLength(1);
    expect(scene.characters[0].id).toBe(idleCharacterId("gemini"));
    expect(scene.characters[0].state).toBe("idle");
    expect(scene.characters[0].zone).toBe("arrival");
    // Not a run: the detail view says plainly that nothing has been observed.
    expect(scene.characters[0].runId).toBeUndefined();
  });

  it("leaves them out when the user does not want them", () => {
    const scene = build(emptyAgentState(), { showIdleAgents: false }, T0, {
      idleProviders: idle,
    });
    expect(scene.characters).toEqual([]);
  });

  it("does not stand one in when that provider is already working", () => {
    const { state, agentId } = seed("gemini", "Gemini");
    const { state: withRun } = addRun(state, agentId, "wA", "Work");

    const scene = build(withRun, { showIdleAgents: true }, T0 + 1000, { idleProviders: idle });
    expect(scene.characters).toHaveLength(1);
    expect(scene.characters[0].runId).toBeDefined();
  });
});

describe("keeping the arrangement still", () => {
  it("keeps a working run at its desk through every live state when auto-arrange is off", () => {
    // With auto-arrange off, a run stops hopping between the desk, the
    // meeting room and the waiting area as its live state fluctuates.
    const { state, agentId } = seed();
    const first = addRun(state, agentId, "wA", "First", T0);
    const second = addRun(first.state, agentId, "wA", "Second", T0 + 1);

    let current = withArtifact(second.state, first.runId, "src/app/page.tsx", T0 + 10);
    current = withArtifact(current, second.runId, "src/app/page.tsx", T0 + 20);

    const arranged = build(current, { autoArrange: true });
    const still = build(current, { autoArrange: false });

    expect(arranged.characters.every((character) => character.zone === "exchange")).toBe(true);
    expect(still.characters.every((character) => character.zone === "work")).toBe(true);
    // The state itself is never hidden — only the movement is.
    expect(still.characters.every((character) => character.state === "communicating")).toBe(true);
  });

  it("still moves a run out of the work area when it actually finishes", () => {
    const { state, agentId } = seed();
    const { state: withRun, runId } = addRun(state, agentId, "wA", "Work");
    const done = setStatus(withRun, runId, "completed", T0 + 10);

    expect(build(done, { autoArrange: false }).characters[0].zone).toBe("done");
  });
});

describe("scale", () => {
  function manyRuns(count: number) {
    const { state, agentId } = seed();
    let current = state;
    for (let i = 0; i < count; i += 1) {
      current = addRun(current, agentId, "wA", `Run ${i}`, T0 + i).state;
    }
    return current;
  }

  it.each([1, 5, 10, 20, 30])("draws %i simultaneous agents without overlap", (count) => {
    const scene = build(manyRuns(count), { density: "detailed" });
    const points = scene.characters.map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)}`);
    expect(new Set(points).size).toBe(points.length);
  });

  it("counts whoever it could not draw", () => {
    const scene = build(manyRuns(40), { density: "minimal" });
    expect(scene.characters.length + scene.hiddenCharacterCount).toBe(40);
    expect(scene.hiddenCharacterCount).toBeGreaterThan(0);
  });

  it("never draws a line to a character it left out", () => {
    // The picture never claims a relationship to something it is not showing.
    const scene = build(manyRuns(40), { density: "minimal" });
    const drawn = new Set(scene.characters.map((character) => character.id));
    for (const handoff of scene.handoffs) {
      expect(drawn.has(handoff.fromCharacterId)).toBe(true);
      expect(drawn.has(handoff.toCharacterId)).toBe(true);
    }
  });

  it("builds a thirty-agent scene in well under a frame", () => {
    const state = manyRuns(30);
    const index = buildAgentDomainIndex(state);

    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      buildWorldScene({
        index,
        workspaceId: "wA",
        settings: { ...DEFAULT_AGENT_WORLD_SETTINGS, density: "detailed" },
        now: T0 + 1000,
      });
    }
    expect((performance.now() - started) / 20).toBeLessThan(16);
  });
});

describe("determinism", () => {
  it("produces the same scene from the same state", () => {
    const { state, agentId } = seed();
    const { state: withRun } = addRun(state, agentId, "wA", "Work");
    expect(build(withRun)).toEqual(build(withRun));
  });
});
