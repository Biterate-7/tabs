import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_AGENT_WORLD_SETTINGS } from "@/lib/agents/world/settings";
import { getWorldTheme } from "@/lib/agents/world/themes";
import { emptyWorldScene } from "@/lib/agents/world/types";
import { AgentWorld } from "./agent-world";
import { AgentWorldDetail, formatElapsed } from "./agent-world-detail";
import type { AgentWorldSettings } from "@/lib/agents/world/settings";
import type { WorldCharacter, WorldScene } from "@/lib/agents/world/types";

const T0 = 1_700_000_000_000;
const THEME = getWorldTheme("office");

function character(over: Partial<WorldCharacter> = {}): WorldCharacter {
  return {
    id: "run:1",
    runId: "1",
    agentId: "a1",
    provider: "claude-code",
    agentName: "Claude Code",
    title: "Implement auth",
    state: "working",
    activity: "Researching competitor architecture",
    zone: "work",
    stationId: "office-work-a",
    stationLabel: "Research desk",
    x: 0.34,
    y: 0.3,
    slot: 0,
    character: { silhouette: "beacon", scale: 1, accessory: "terminal" },
    startedAt: T0,
    updatedAt: T0 + 60_000,
    ...over,
  };
}

function scene(over: Partial<WorldScene> = {}): WorldScene {
  return { ...emptyWorldScene(THEME), characters: [character()], ...over };
}

function renderWorld(
  over: { scene?: WorldScene; settings?: Partial<AgentWorldSettings>; selectedId?: string | null } = {},
  onSelect = vi.fn()
) {
  const result = render(
    <AgentWorld
      scene={over.scene ?? scene()}
      settings={{ ...DEFAULT_AGENT_WORLD_SETTINGS, ...over.settings }}
      now={T0 + 120_000}
      selectedId={over.selectedId ?? null}
      onSelect={onSelect}
    />
  );
  return { ...result, onSelect };
}

describe("drawing the world", () => {
  it("gives every agent a focusable button", () => {
    // The world is DOM, not canvas. That is the whole accessibility story:
    // Tab reaches every agent, and a screen reader reads each one out.
    renderWorld();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("says who, what state, what task and where, in one accessible name", () => {
    renderWorld();
    expect(
      screen.getByRole("button", {
        name: "Claude Code — Working — Researching competitor architecture — at Research desk",
      })
    ).toBeTruthy();
  });

  it("names the room itself, with how many agents are in it", () => {
    renderWorld();
    expect(screen.getByRole("group", { name: /office floor, 1 agent$/ })).toBeTruthy();
  });

  it("says the room is empty rather than saying nothing", () => {
    renderWorld({ scene: emptyWorldScene(THEME) });
    expect(screen.getByRole("group", { name: /office floor, empty/ })).toBeTruthy();
    expect(screen.getByText("Your agents will appear here as they work")).toBeTruthy();
  });

  it("leaves the room visible behind its own empty copy", () => {
    // The copy sits over the scenery rather than replacing it, so someone
    // arriving at a world with nothing in it still sees what the world is.
    const { container } = renderWorld({ scene: emptyWorldScene(THEME) });
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
    expect(container.querySelector(".pointer-events-none.absolute.inset-0")).not.toBeNull();
  });

  it("says nobody is working when the room holds only idle stand-ins", () => {
    renderWorld({
      scene: scene({
        characters: [
          character({
            id: "idle:gemini",
            runId: undefined,
            agentId: undefined,
            state: "idle",
            activity: undefined,
            agentName: "Gemini",
            presence: "connected",
          }),
        ],
      }),
    });

    expect(screen.getByRole("group", { name: /1 agent, none working/ })).toBeTruthy();
    expect(screen.getByText(/Nothing is running in this workspace yet/)).toBeTruthy();
  });

  it("draws twenty agents, each with its own button", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      character({ id: `run:${index}`, runId: String(index), agentName: `Agent ${index}` })
    );
    renderWorld({ scene: scene({ characters: many }) });
    expect(screen.getAllByRole("button")).toHaveLength(20);
  });

  it("says how many it could not draw rather than omitting them silently", () => {
    renderWorld({ scene: scene({ hiddenCharacterCount: 6 }) });
    expect(screen.getByText("6 more agents not shown at this density.")).toBeTruthy();
  });

  it("uses the singular for one hidden agent", () => {
    renderWorld({ scene: scene({ hiddenCharacterCount: 1 }) });
    expect(screen.getByText("1 more agent not shown at this density.")).toBeTruthy();
  });

  it("titles itself with the world's name when one was given", () => {
    render(
      <AgentWorld
        scene={scene()}
        settings={DEFAULT_AGENT_WORLD_SETTINGS}
        worldName="Research"
        now={T0}
        selectedId={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText("RESEARCH")).toBeTruthy();
  });
});

describe("hovering and focusing", () => {
  it("captions the agent under the pointer", async () => {
    const user = userEvent.setup();
    renderWorld();

    await user.hover(screen.getByRole("button"));
    expect(screen.getByText(/Claude Code · Working · Researching competitor architecture/)).toBeTruthy();
  });

  it("captions the agent that has keyboard focus, identically", async () => {
    // One behaviour for both, rather than a hover affordance a keyboard user
    // never reaches.
    const user = userEvent.setup();
    renderWorld();

    await user.tab();
    expect(screen.getByText(/Claude Code · Working/)).toBeTruthy();
  });
});

describe("selecting an agent", () => {
  it("opens the detail view on click", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderWorld();

    await user.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("run:1");
  });

  it("opens it from the keyboard too", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderWorld();

    await user.tab();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("run:1");
  });

  it("deselects when the selected agent is clicked again", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderWorld({ selectedId: "run:1" });

    await user.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("marks the selected agent as pressed", () => {
    renderWorld({ selectedId: "run:1" });
    expect(screen.getByRole("button", { name: /Claude Code/ }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("shows the detail card for the selection", () => {
    renderWorld({ selectedId: "run:1" });
    expect(screen.getByText("Implement auth")).toBeTruthy();
    expect(screen.getByText("At Research desk")).toBeTruthy();
  });

  it("closes the detail card with Escape", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderWorld({ selectedId: "run:1" });

    await user.tab();
    await user.keyboard("{Escape}");
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe("honouring the settings", () => {
  it("draws no scenery when scenery is off", () => {
    const withScenery = renderWorld();
    const sceneryCount = withScenery.container.querySelectorAll("rect").length;
    withScenery.unmount();

    const without = renderWorld({
      settings: { effects: { ...DEFAULT_AGENT_WORLD_SETTINGS.effects, scenery: false } },
    });
    expect(without.container.querySelectorAll("rect").length).toBeLessThan(sceneryCount);
  });

  it("draws no handoff line when trails are off", () => {
    const withHandoff = scene({
      characters: [character(), character({ id: "run:2", runId: "2", x: 0.6, y: 0.5 })],
      handoffs: [
        {
          id: "run:1->run:2",
          fromCharacterId: "run:1",
          toCharacterId: "run:2",
          via: "file",
          label: "shared src/app/page.tsx",
        },
      ],
    });

    const on = renderWorld({ scene: withHandoff });
    expect(on.container.querySelectorAll("[data-agent-handoff]")).toHaveLength(1);
    on.unmount();

    const off = renderWorld({
      scene: withHandoff,
      settings: { effects: { ...DEFAULT_AGENT_WORLD_SETTINGS.effects, handoffTrails: false } },
    });
    expect(off.container.querySelectorAll("[data-agent-handoff]")).toHaveLength(0);
  });

  it("drops the travelling packet when particles are off, keeping the line", () => {
    const withHandoff = scene({
      characters: [character(), character({ id: "run:2", runId: "2", x: 0.6, y: 0.5 })],
      handoffs: [
        {
          id: "run:1->run:2",
          fromCharacterId: "run:1",
          toCharacterId: "run:2",
          via: "file",
          label: "shared src/app/page.tsx",
        },
      ],
    });

    const { container } = renderWorld({
      scene: withHandoff,
      settings: { effects: { ...DEFAULT_AGENT_WORLD_SETTINGS.effects, particles: false } },
    });

    expect(container.querySelectorAll("[data-agent-handoff]")).toHaveLength(1);
    expect(container.querySelectorAll(".agent-world-packet")).toHaveLength(0);
  });

  it("never draws a line to an agent that is not on stage", () => {
    const { container } = renderWorld({
      scene: scene({
        handoffs: [
          {
            id: "run:1->run:missing",
            fromCharacterId: "run:1",
            toCharacterId: "run:missing",
            via: "file",
            label: "shared something",
          },
        ],
      }),
    });

    expect(container.querySelectorAll("[data-agent-handoff]")).toHaveLength(0);
  });

  it("labels stations only at the detailed density", () => {
    const occupied = scene({ occupiedStationIds: ["office-work-a"] });

    const balanced = renderWorld({ scene: occupied, settings: { density: "balanced" } });
    expect(balanced.queryByText("Research desk")).toBeNull();
    balanced.unmount();

    const detailed = renderWorld({ scene: occupied, settings: { density: "detailed" } });
    expect(detailed.getByText("Research desk")).toBeTruthy();
  });

  it("holds every agent still when animation is off", () => {
    const { container } = renderWorld({ settings: { animation: "off" } });
    for (const mark of container.querySelectorAll<HTMLElement>(".agent-mark")) {
      expect(mark.style.animationName).toBe("");
    }
  });

  it("keeps the state readable as a word even with animation off", () => {
    // Never communicate an important state solely through animation.
    renderWorld({ settings: { animation: "off" }, selectedId: "run:1" });
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("makes the stage reachable by keyboard only for the free camera", () => {
    const stat = renderWorld({ settings: { camera: "static" } });
    expect(stat.getByRole("group").getAttribute("tabindex")).toBe("-1");
    stat.unmount();

    const free = renderWorld({ settings: { camera: "free" } });
    expect(free.getByRole("group").getAttribute("tabindex")).toBe("0");
  });

  it("offers a grab cursor only where dragging does something", () => {
    // A control called "Free" that only answered the keyboard would be a
    // setting that does not do what it is named.
    const free = renderWorld({ settings: { camera: "free" } });
    expect((free.getByRole("group") as HTMLElement).style.cursor).toBe("grab");
    free.unmount();

    const stat = renderWorld({ settings: { camera: "static" } });
    expect((stat.getByRole("group") as HTMLElement).style.cursor).toBe("");
  });

  it("frames the active agents when the camera follows them", () => {
    // Static shows the whole room; follow-active zooms toward whoever is
    // working. The transform is the observable difference.
    const stat = renderWorld({ settings: { camera: "static" } });
    const staticTransform = (stat.container.querySelector(
      ".agent-world-stage > div"
    ) as HTMLElement).style.transform;
    stat.unmount();

    const follow = renderWorld({ settings: { camera: "follow-active" } });
    const followTransform = (follow.container.querySelector(
      ".agent-world-stage > div"
    ) as HTMLElement).style.transform;

    expect(staticTransform).toContain("scale(1)");
    expect(followTransform).not.toBe(staticTransform);
  });
});

describe("the detail view", () => {
  it("states the run's own status description, so 'Thinking' is never left to interpretation", () => {
    render(
      <AgentWorldDetail character={character({ state: "thinking" })} now={T0 + 60_000} />
    );
    expect(screen.getByText("Running, and has not reported what it is working on.")).toBeTruthy();
  });

  it("says plainly that a connected agent has done nothing", () => {
    render(
      <AgentWorldDetail
        character={character({ runId: undefined, agentId: undefined, startedAt: undefined })}
        now={T0}
      />
    );
    expect(
      screen.getByText("Connected. No activity has been observed in this workspace yet.")
    ).toBeTruthy();
  });

  it("lists files, work and shared work when there is any", () => {
    render(
      <AgentWorldDetail
        character={character()}
        now={T0 + 60_000}
        detail={{
          events: [{ id: "e1", summary: "Edited graph-canvas.tsx", timestamp: T0 }],
          files: [{ artifactId: "a1", relativePath: "src/app/page.tsx", role: "edited" }],
          workItems: [{ id: "w1", title: "Implement auth", status: "active" }],
          handoffs: [
            { id: "h1", label: "shared src/app/page.tsx", withName: "Gemini", direction: "to" },
          ],
        }}
      />
    );

    expect(screen.getByText("Edited src/app/page.tsx")).toBeTruthy();
    expect(screen.getByText(/shared src\/app\/page.tsx to Gemini/)).toBeTruthy();
    expect(screen.getByText("Edited graph-canvas.tsx")).toBeTruthy();
  });

  it("omits a section entirely rather than showing an empty heading", () => {
    render(<AgentWorldDetail character={character()} now={T0} />);
    expect(screen.queryByText("FILES")).toBeNull();
    expect(screen.queryByText("WORK")).toBeNull();
  });

  it("shows progress only when a real count exists", () => {
    const withProgress = render(
      <AgentWorldDetail character={character({ progress: { completed: 2, total: 5 } })} now={T0} />
    );
    expect(screen.getByText("2 / 5 done")).toBeTruthy();
    withProgress.unmount();

    render(<AgentWorldDetail character={character()} now={T0} />);
    expect(screen.queryByText(/\d+ \/ \d+ done/)).toBeNull();
  });
});

describe("elapsed time", () => {
  it("is coarse, because the clock it measures against is", () => {
    expect(formatElapsed(30_000)).toBe("under a minute");
    expect(formatElapsed(5 * 60_000)).toBe("5 min");
    expect(formatElapsed(90 * 60_000)).toBe("1 hr 30 min");
    expect(formatElapsed(3 * 24 * 60 * 60_000)).toBe("3 days");
  });

  it("reports nothing rather than a negative or nonsense duration", () => {
    expect(formatElapsed(-1)).toBeNull();
    expect(formatElapsed(Number.NaN)).toBeNull();
  });
});
