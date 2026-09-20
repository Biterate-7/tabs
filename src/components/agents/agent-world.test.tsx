import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

const RESEARCH = THEME.stations.find((station) => station.craft === "research")!;

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
    craft: "research",
    zone: "work",
    stationId: RESEARCH.id,
    stationLabel: RESEARCH.label,
    roomId: "office-research",
    roomName: "Research Lab",
    x: RESEARCH.x,
    y: RESEARCH.y,
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

/**
 * The agents, apart from the rooms and the camera controls.
 *
 * All three are buttons on the same stage, which is the point — the world is
 * DOM throughout — so the figures carry a marker attribute rather than the
 * tests guessing at accessible names.
 */
function agentButtons(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-world-character]")];
}

/**
 * A stage with a real measured size.
 *
 * jsdom lays nothing out and its ResizeObserver stub never fires, so the
 * world falls back to percentage positioning and draws no camera transform at
 * all. Anything about the camera has to state a size first.
 */
function withStageSize(width: number, height: number): () => void {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe() {
      this.#callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  } as never;

  return () => {
    globalThis.ResizeObserver = original;
  };
}

let restoreStageSize: (() => void) | null = null;

afterEach(() => {
  restoreStageSize?.();
  restoreStageSize = null;
});

function measured(width: number, height: number) {
  restoreStageSize = withStageSize(width, height);
}

describe("drawing the world", () => {
  it("gives every agent a focusable button", () => {
    // The world is DOM, not canvas. That is the whole accessibility story:
    // Tab reaches every agent, and a screen reader reads each one out.
    const { container } = renderWorld();
    expect(agentButtons(container)).toHaveLength(1);
    expect(agentButtons(container)[0].tagName).toBe("BUTTON");
  });

  it("says who, what state, what task and where, in one accessible name", () => {
    renderWorld();
    expect(
      screen.getByRole("button", {
        name: "Claude Code — Working — Researching competitor architecture — in the Research Lab",
      })
    ).toBeTruthy();
  });

  it("names the world itself, with how many agents are in it", () => {
    renderWorld();
    expect(screen.getByRole("group", { name: /office headquarters, 1 agent$/ })).toBeTruthy();
  });

  it("says the world is empty rather than saying nothing", () => {
    renderWorld({ scene: emptyWorldScene(THEME) });
    expect(screen.getByRole("group", { name: /office headquarters, empty/ })).toBeTruthy();
    expect(screen.getByText("Your agents will appear here as they work")).toBeTruthy();
  });

  it("leaves the world visible behind its own empty copy", () => {
    // The copy sits over the scenery rather than replacing it, so someone
    // arriving at a world with nothing in it still sees what the world is.
    const { container } = renderWorld({ scene: emptyWorldScene(THEME) });
    expect(container.querySelectorAll("polygon").length).toBeGreaterThan(0);
    expect(container.querySelector(".pointer-events-none.absolute.inset-0")).not.toBeNull();
  });

  it("says nobody is working when the world holds only idle stand-ins", () => {
    renderWorld({
      scene: scene({
        characters: [
          character({
            id: "idle:gemini",
            runId: undefined,
            agentId: undefined,
            craft: undefined,
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
    const { container } = renderWorld({ scene: scene({ characters: many }) });
    expect(agentButtons(container)).toHaveLength(20);
  });

  it("stacks nearer agents over further ones", () => {
    // Depth order, which the isometric projection makes meaningful: further
    // down the stage is nearer the camera, so a figure in front has to draw
    // over the one behind it rather than under.
    const { container } = renderWorld({
      scene: scene({
        characters: [
          character({ id: "run:far", y: 0.3 }),
          character({ id: "run:near", y: 0.7 }),
        ],
      }),
    });

    const [far, near] = agentButtons(container);
    expect(Number(near.style.zIndex)).toBeGreaterThan(Number(far.style.zIndex));
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
    expect(screen.getByText("Research")).toBeTruthy();
  });
});

describe("the rooms", () => {
  it("makes every room a button that says what it is for", () => {
    renderWorld();
    expect(
      screen.getByRole("button", {
        name: /^Research Lab\. Runs reading, exploring and looking things up work here\./,
      })
    ).toBeTruthy();
  });

  it("counts the agents standing in each room", () => {
    renderWorld();
    expect(screen.getByRole("button", { name: /Research Lab\..*1 agent here\.$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Data Centre\..*0 agents here\.$/ })).toBeTruthy();
  });

  it("opens the room's card on click, listing who is in it", async () => {
    const user = userEvent.setup();
    renderWorld();

    await user.click(screen.getByRole("button", { name: /^Research Lab\./ }));

    const card = screen.getByText("1 agent here").closest("div")!;
    expect(within(card).getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Claude Code · Researching competitor architecture")).toBeTruthy();
  });

  it("says an empty room is empty rather than showing nothing", async () => {
    const user = userEvent.setup();
    renderWorld();

    await user.click(screen.getByRole("button", { name: /^Break Area\./ }));
    expect(screen.getByText("No agents here right now.")).toBeTruthy();
  });

  it("says plainly that nobody works in the infrastructure room", async () => {
    // A room with no stations can never hold an agent, and the honest card
    // says so rather than implying it is merely quiet at the moment.
    const user = userEvent.setup();
    renderWorld();

    await user.click(screen.getByRole("button", { name: /^Data Centre\./ }));
    expect(screen.getByText("Infrastructure. No agent works in here.")).toBeTruthy();
  });

  it("opens the agent from the room card", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderWorld();

    await user.click(screen.getByRole("button", { name: /^Research Lab./ }));

    const card = screen.getByText("1 agent here").closest("div")!;
    await user.click(within(card).getByRole("button", { name: /Claude Code/ }));
    expect(onSelect).toHaveBeenCalledWith("run:1");
  });

  it("is reachable and openable from the keyboard", async () => {
    const user = userEvent.setup();
    renderWorld();

    const room = screen.getByRole("button", { name: /^Research Lab\./ });
    room.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("1 agent here")).toBeTruthy();
  });

  it("selecting an agent closes the open room card", async () => {
    const user = userEvent.setup();
    const { container } = renderWorld();

    await user.click(screen.getByRole("button", { name: /^Research Lab\./ }));
    expect(screen.queryByText("1 agent here")).not.toBeNull();

    await user.click(agentButtons(container)[0]);
    expect(screen.queryByText("1 agent here")).toBeNull();
  });
});

describe("hovering and focusing", () => {
  it("captions the agent under the pointer", async () => {
    const user = userEvent.setup();
    const { container } = renderWorld();

    await user.hover(agentButtons(container)[0]);
    expect(
      screen.getByText(/Claude Code · Working · Researching competitor architecture/)
    ).toBeTruthy();
  });

  it("captions the agent that has keyboard focus, identically", async () => {
    // One behaviour for both, rather than a hover affordance a keyboard user
    // never reaches.
    const user = userEvent.setup();
    renderWorld();

    await user.tab(); // the stage
    await user.tab(); // the first agent
    expect(screen.getByText(/Claude Code · Working/)).toBeTruthy();
  });

  it("captions a room under the pointer with what happens there", async () => {
    const user = userEvent.setup();
    renderWorld();

    await user.hover(screen.getByRole("button", { name: /^Development Room\./ }));
    expect(
      screen.getByText(/Development Room · Runs writing, refactoring and fixing code work here\./)
    ).toBeTruthy();
  });

  it("reaches the agents before the rooms when tabbing", async () => {
    // Document order is tab order, and someone who opened the Agent World
    // came for the agents rather than for eleven rooms in front of them.
    const user = userEvent.setup();
    const { container } = renderWorld();

    await user.tab(); // the stage itself, which is the pan and zoom surface
    await user.tab();
    expect(document.activeElement).toBe(agentButtons(container)[0]);
  });
});

describe("selecting an agent", () => {
  it("opens the detail view on click", async () => {
    const user = userEvent.setup();
    const { container, onSelect } = renderWorld();

    await user.click(agentButtons(container)[0]);
    expect(onSelect).toHaveBeenCalledWith("run:1");
  });

  it("opens it from the keyboard too", async () => {
    const user = userEvent.setup();
    const { container, onSelect } = renderWorld();

    agentButtons(container)[0].focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("run:1");
  });

  it("deselects when the selected agent is clicked again", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderWorld({ selectedId: "run:1" });

    await user.click(screen.getByRole("button", { name: /^Claude Code —/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("marks the selected agent as pressed", () => {
    renderWorld({ selectedId: "run:1" });
    expect(
      screen.getByRole("button", { name: /^Claude Code —/ }).getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("shows the detail card for the selection", () => {
    renderWorld({ selectedId: "run:1" });
    expect(screen.getByText("Implement auth")).toBeTruthy();
    expect(screen.getByText(`At ${RESEARCH.label}`)).toBeTruthy();
  });

  it("closes the detail card with Escape", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderWorld({ selectedId: "run:1" });

    await user.tab();
    await user.keyboard("{Escape}");
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe("the camera", () => {
  it("draws no transform until the stage has been measured", () => {
    // Server render and first paint. Everybody is placed by percentage, which
    // is correct and simply has nothing to animate from.
    const { container } = renderWorld();
    const camera = container.querySelector<HTMLElement>(".agent-world-camera")!;
    expect(camera.style.transform).toBe("");
  });

  it("fits the world to the stage, then zooms in to stay legible", async () => {
    // A narrow box cannot show the whole world at a readable size, so it
    // shows part of it instead: the world is drawn to fit and the camera
    // starts closer. A phone gets a window into a headquarters rather than a
    // photograph of one taken from too far off.
    measured(400, 700);
    const { container } = renderWorld();

    const camera = container.querySelector<HTMLElement>(".agent-world-camera")!;
    // 400 wide against a 1000-unit stage is the limiting axis.
    expect(camera.style.width).toBe("400px");
    // And at that scale a figure would be 12px, so the camera opens zoomed in.
    expect(camera.style.transform).not.toContain("scale(1)");
  });

  it("frames the active agents when the camera follows them", async () => {
    measured(1000, 700);
    const many = scene({
      characters: [
        character({ id: "run:1", state: "working", x: 0.45, y: 0.5 }),
        character({ id: "run:2", state: "working", x: 0.5, y: 0.55 }),
      ],
    });

    const stat = renderWorld({ scene: many, settings: { camera: "static" } });
    const still = stat.container.querySelector<HTMLElement>(".agent-world-camera")!.style.transform;
    stat.unmount();

    const follow = renderWorld({ scene: many, settings: { camera: "follow-active" } });
    const framed = follow.container.querySelector<HTMLElement>(".agent-world-camera")!.style
      .transform;

    expect(still).toContain("scale(1)");
    expect(framed).not.toBe(still);
  });

  it("zooms in and back out from its own controls", async () => {
    measured(1000, 700);
    const user = userEvent.setup();
    const { container } = renderWorld();
    const camera = container.querySelector<HTMLElement>(".agent-world-camera")!;

    expect(camera.style.transform).toContain("scale(1)");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(camera.style.transform).toContain("scale(1.25)");

    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(camera.style.transform).toContain("scale(1)");
  });

  it("never zooms out past the whole world", async () => {
    measured(1000, 700);
    renderWorld();
    // At the default framing there is nothing further out to go to, so the
    // control says so rather than doing nothing when pressed.
    expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers a reset only once the view has actually been moved", async () => {
    measured(1000, 700);
    const user = userEvent.setup();
    const { container } = renderWorld();

    const reset = screen.getByRole("button", { name: "Reset view" });
    expect(reset.hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(reset.hasAttribute("disabled")).toBe(false);

    await user.click(reset);
    expect(
      container.querySelector<HTMLElement>(".agent-world-camera")!.style.transform
    ).toContain("scale(1)");
  });

  it("zooms from the keyboard in every camera mode", async () => {
    // The camera is drivable whichever framing the setting chose. A mode
    // called "Static" that refused to be nudged would be a preference
    // masquerading as a lock.
    measured(1000, 700);
    const user = userEvent.setup();
    const { container } = renderWorld({ settings: { camera: "static" } });

    container.querySelector<HTMLElement>(".agent-world-stage")!.focus();
    await user.keyboard("+");

    expect(
      container.querySelector<HTMLElement>(".agent-world-camera")!.style.transform
    ).not.toContain("scale(1)");
  });

  it("drags from anywhere, including from over a room", async () => {
    // The rooms cover almost the whole floor. A drag that refused to start on
    // one would leave the camera draggable only from the gaps between them,
    // which is the same as not being draggable.
    measured(1000, 700);
    const { container } = renderWorld();
    const stage = container.querySelector<HTMLElement>(".agent-world-stage")!;
    const room = container.querySelector<Element>(".agent-world-room")!;

    // Zoomed in first, because at the default framing there is nowhere to pan
    // to and the clamp correctly refuses to move.
    await userEvent.setup().click(screen.getByRole("button", { name: "Zoom in" }));
    const before = container.querySelector<HTMLElement>(".agent-world-camera")!.style.transform;

    fireEvent.pointerDown(room, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 320, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 320, clientY: 300 });

    expect(container.querySelector<HTMLElement>(".agent-world-camera")!.style.transform).not.toBe(
      before
    );
  });

  it("does not open a room at the end of a drag", async () => {
    // The other half of the same behaviour: having dragged the world by its
    // floor, you have not asked to inspect the room you let go over.
    measured(1000, 700);
    const { container } = renderWorld();
    const stage = container.querySelector<HTMLElement>(".agent-world-stage")!;
    const room = screen.getByRole("button", { name: /^Research Lab\./ });

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 330, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 330, clientY: 300 });
    fireEvent.click(room);

    expect(screen.queryByText("1 agent here")).toBeNull();
  });

  it("still opens a room on a click that did not travel", async () => {
    measured(1000, 700);
    const { container } = renderWorld();
    const stage = container.querySelector<HTMLElement>(".agent-world-stage")!;
    const room = screen.getByRole("button", { name: /^Research Lab\./ });

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 400, clientY: 300 });
    // Two pixels of hand-shake is not a drag.
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 402, clientY: 301 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 402, clientY: 301 });
    fireEvent.click(room);

    expect(screen.getByText("1 agent here")).toBeTruthy();
  });

  it("focuses the working agents on request", async () => {
    measured(1000, 700);
    const user = userEvent.setup();
    const { container } = renderWorld({ settings: { camera: "static" } });

    await user.click(screen.getByRole("button", { name: "Focus active agents" }));
    expect(
      container.querySelector<HTMLElement>(".agent-world-camera")!.style.transform
    ).not.toContain("scale(1)");
  });
});

describe("honouring the settings", () => {
  it("draws no scenery when scenery is off", () => {
    const withScenery = renderWorld();
    const sceneryCount = withScenery.container.querySelectorAll("polygon").length;
    withScenery.unmount();

    const without = renderWorld({
      settings: { effects: { ...DEFAULT_AGENT_WORLD_SETTINGS.effects, scenery: false } },
    });
    expect(without.container.querySelectorAll("polygon").length).toBeLessThan(sceneryCount);
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

  it("drops the travelling packet when data streams are off, keeping the line", () => {
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

  it("parks the traffic when ambient life is off", () => {
    const on = renderWorld({ scene: scene({ theme: getWorldTheme("city") }) });
    expect(on.container.querySelectorAll(".agent-world-vehicle").length).toBeGreaterThan(0);
    on.unmount();

    const off = renderWorld({
      scene: scene({ theme: getWorldTheme("city") }),
      settings: { effects: { ...DEFAULT_AGENT_WORLD_SETTINGS.effects, ambientLife: false } },
    });
    expect(off.container.querySelectorAll(".agent-world-vehicle")).toHaveLength(0);
  });

  it("names occupied rooms only at the detailed density", () => {
    const balanced = renderWorld({ settings: { density: "balanced" } });
    expect(balanced.container.querySelector("svg text")).toBeNull();
    balanced.unmount();

    const detailed = renderWorld({ settings: { density: "detailed" } });
    expect(detailed.container.querySelector("svg text")?.textContent).toBe("Research Lab");
  });

  it("names no room that nobody is standing in", () => {
    const { container } = renderWorld({
      scene: emptyWorldScene(THEME),
      settings: { density: "detailed" },
    });
    expect(container.querySelector("svg text")).toBeNull();
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

  it("thins the environment on a phone-sized stage", () => {
    // §14: a phone is not a shrunken desktop. It is the same world with less
    // furniture and the camera already closer, so what is left is readable.
    measured(1000, 700);
    const wide = renderWorld({ settings: { density: "detailed" } });
    const wideCount = wide.container.querySelectorAll("polygon").length;
    wide.unmount();
    restoreStageSize?.();

    measured(380, 600);
    const narrow = renderWorld({ settings: { density: "detailed" } });
    expect(narrow.container.querySelectorAll("polygon").length).toBeLessThan(wideCount);
  });

  it("keeps the user's own detail setting as a ceiling, not a floor", () => {
    // Asking for Minimal on a desktop still gets Minimal.
    measured(1000, 700);
    const minimal = renderWorld({ settings: { density: "minimal" } });
    const minimalCount = minimal.container.querySelectorAll("polygon").length;
    minimal.unmount();
    restoreStageSize?.();

    measured(1000, 700);
    const detailed = renderWorld({ settings: { density: "detailed" } });
    expect(detailed.container.querySelectorAll("polygon").length).toBeGreaterThan(minimalCount);
  });
});

describe("the detail view", () => {
  it("states the run's own status description, so 'Thinking' is never left to interpretation", () => {
    render(<AgentWorldDetail character={character({ state: "thinking" })} now={T0 + 60_000} />);
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
    expect(screen.queryByText("Files")).toBeNull();
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
