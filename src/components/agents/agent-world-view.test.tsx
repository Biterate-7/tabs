import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import { createAgent } from "@/lib/agents/registry";
import { createRun, updateRun } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { buildWorldScene } from "@/lib/agents/world/scene";
import { DEFAULT_AGENT_WORLD_SETTINGS } from "@/lib/agents/world/settings";
import { AgentWorldScreen } from "./agent-world-view";
import type { AgentWorldSettings } from "@/lib/agents/world/settings";
import type { WorldRosterEntry } from "@/lib/agents/world/roster";
import type { WorldScene } from "@/lib/agents/world/types";

/**
 * The Agent World as a destination.
 *
 * Everything here goes through the real scene builder rather than a
 * hand-written scene, because the claims being tested are about what a user
 * actually finds when they open the view — and a fixture scene could satisfy
 * every assertion below while the builder that produces the real one did
 * something else entirely.
 *
 * The central case is the first one: nobody connected, nothing running, a
 * brand-new user. That state used to be unreachable and is now the one the
 * feature has to be good at.
 */

const T0 = 1_700_000_000_000;
const WORKSPACE = "w1";

/** The shipped catalogue as it looks to someone who has connected nothing. */
const UNCONNECTED_ROSTER: WorldRosterEntry[] = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    presence: "available",
    statusLabel: "Not connected",
    statusKind: "disconnected",
  },
  {
    provider: "gemini",
    displayName: "Gemini",
    presence: "available",
    statusLabel: "Unavailable",
    statusKind: "unavailable",
  },
];

const CONNECTED_ROSTER: WorldRosterEntry[] = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    presence: "connected",
    statusLabel: "Connected",
    statusKind: "connected",
  },
];

/** Agent state with one run genuinely in flight. */
function stateWithLiveRun() {
  const agent = createAgent(
    emptyAgentState(),
    { provider: "claude-code", name: "Claude Code" },
    T0
  );
  if (!agent.ok) throw new Error("fixture failed");
  const run = createRun(
    agent.state,
    { agentId: agent.agent.id, workspaceId: WORKSPACE, title: "Implement auth" },
    T0
  );
  if (!run.ok) throw new Error("fixture failed");
  // Through the domain's own updater rather than by hand: what the world
  // captions is whatever `currentActivity` the domain holds, and a fixture
  // that set the field directly would stop proving that.
  const working = updateRun(
    run.state,
    run.run.id,
    { currentActivity: "Editing the session reader" },
    T0 + 1000
  );
  if (!working.ok) throw new Error("fixture failed");
  return working.state;
}

function sceneFrom(
  state = emptyAgentState(),
  roster: readonly WorldRosterEntry[] = UNCONNECTED_ROSTER,
  settings: AgentWorldSettings = DEFAULT_AGENT_WORLD_SETTINGS
): WorldScene {
  return buildWorldScene({
    index: buildAgentDomainIndex(state),
    workspaceId: WORKSPACE,
    settings,
    now: T0 + 60_000,
    idleProviders: roster,
  });
}

function renderScreen(
  over: {
    scene?: WorldScene;
    settings?: Partial<AgentWorldSettings>;
    roster?: readonly WorldRosterEntry[];
    selectedId?: string | null;
  } = {}
) {
  const onClose = vi.fn();
  const onOpenConnectors = vi.fn();
  const onOpenWorldSettings = vi.fn();
  const onSelect = vi.fn();

  const result = render(
    <AgentWorldScreen
      scene={over.scene ?? sceneFrom()}
      settings={{ ...DEFAULT_AGENT_WORLD_SETTINGS, ...over.settings }}
      workspaceName="Research"
      now={T0 + 60_000}
      selectedId={over.selectedId ?? null}
      onSelect={onSelect}
      roster={over.roster ?? UNCONNECTED_ROSTER}
      onClose={onClose}
      onOpenConnectors={onOpenConnectors}
      onOpenWorldSettings={onOpenWorldSettings}
    />
  );

  return { ...result, onClose, onOpenConnectors, onOpenWorldSettings, onSelect };
}

describe("opening Agent World with nothing running", () => {
  it("shows the world itself rather than a blank screen", () => {
    renderScreen();
    expect(screen.getByRole("group", { name: /office floor/ })).toBeTruthy();
  });

  it("names itself, so what this is takes no interpretation", () => {
    renderScreen();
    expect(screen.getByRole("heading", { name: "Agent World" })).toBeTruthy();
  });

  it("stands the available connector identities in the room", () => {
    // The claim the whole rework rests on: a user who has connected nothing
    // still sees who could be here.
    renderScreen();
    expect(screen.getByRole("button", { name: /^Claude Code — Idle/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Gemini — Idle/ })).toBeTruthy();
  });

  it("says plainly that an unconnected agent is not connected", () => {
    // Drawn, but never dressed up as connected — the figure carries its
    // connector's own status word in its accessible name.
    renderScreen();
    expect(screen.getByRole("button", { name: /Claude Code — Idle — Not connected/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Gemini — Idle — Unavailable/ })).toBeTruthy();
  });

  it("explains what will happen here, in one sentence", () => {
    renderScreen();
    expect(screen.getByText(/Your agents will appear here as they work/)).toBeTruthy();
  });

  it("lists the roster in text beside the figures", () => {
    renderScreen();
    const roster = screen.getByRole("region", { name: "AGENTS IN THIS WORLD" });
    expect(within(roster).getByText("Claude Code")).toBeTruthy();
    expect(within(roster).getByText("Not connected")).toBeTruthy();
    expect(within(roster).getByText("Unavailable")).toBeTruthy();
  });

  it("tells a screen reader that nobody in the room is working", () => {
    renderScreen();
    expect(screen.getByRole("group", { name: /2 agents, none working/ })).toBeTruthy();
  });

  it("invents no activity for an idle agent", () => {
    // §8, executed. Every figure is idle and none of them claims otherwise.
    const scene = sceneFrom();
    expect(scene.characters.every((character) => character.state === "idle")).toBe(true);
    expect(scene.characters.every((character) => character.runId === undefined)).toBe(true);
    expect(scene.handoffs).toEqual([]);
  });

  it("still draws the room when the catalogue itself is empty", () => {
    renderScreen({ scene: sceneFrom(emptyAgentState(), []), roster: [] });
    expect(screen.getByRole("group", { name: /office floor, empty/ })).toBeTruthy();
    expect(screen.getByText(/Your agents will appear here as they work/)).toBeTruthy();
  });
});

describe("reaching connectors and settings from the top of the world", () => {
  it("goes to AI connectors in one click", () => {
    const { onOpenConnectors } = renderScreen();
    screen.getByRole("button", { name: "AI connectors" }).click();
    expect(onOpenConnectors).toHaveBeenCalledTimes(1);
  });

  it("goes to Agent World settings in one click", () => {
    const { onOpenWorldSettings } = renderScreen();
    screen.getByRole("button", { name: "Agent World settings" }).click();
    expect(onOpenWorldSettings).toHaveBeenCalledTimes(1);
  });

  it("offers both a back control and a close control", () => {
    const { onClose } = renderScreen();
    screen.getByRole("button", { name: "Back" }).click();
    screen.getByRole("button", { name: "Close Agent World" }).click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("groups the quick-access controls as navigation", () => {
    renderScreen();
    const nav = screen.getByRole("navigation", { name: "Agent World" });
    expect(within(nav).getByRole("button", { name: "AI connectors" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Agent World settings" })).toBeTruthy();
  });

  it("offers connectors from the idle copy as well as the header", () => {
    renderScreen({ scene: sceneFrom(emptyAgentState(), []), roster: [] });
    // Two routes to the same place: the header, and the empty room's own copy.
    expect(screen.getAllByRole("button", { name: /AI connectors/ })).toHaveLength(2);
  });
});

describe("when real agents start working", () => {
  it("draws the run, not a stand-in, for the provider that is busy", () => {
    const scene = sceneFrom(stateWithLiveRun(), CONNECTED_ROSTER);
    renderScreen({ scene, roster: CONNECTED_ROSTER });

    expect(
      screen.getByRole("button", {
        name: /Claude Code — Working — Editing the session reader/,
      })
    ).toBeTruthy();
    // The idle stand-in stepped aside rather than doubling the agent up.
    expect(screen.queryByRole("button", { name: /Claude Code — Idle/ })).toBeNull();
  });

  it("stops saying the room is idle the moment something is running", () => {
    const scene = sceneFrom(stateWithLiveRun(), CONNECTED_ROSTER);
    renderScreen({ scene, roster: CONNECTED_ROSTER });

    expect(screen.queryByText(/Your agents will appear here as they work/)).toBeNull();
    expect(screen.getByRole("group", { name: /1 agent$/ })).toBeTruthy();
  });

  it("puts a working agent in a work zone and an idle one in arrival", () => {
    const working = sceneFrom(stateWithLiveRun(), CONNECTED_ROSTER);
    expect(working.characters[0].zone).toBe("work");
    expect(sceneFrom().characters[0].zone).toBe("arrival");
  });

  it("opens the full detail card for the selected run", () => {
    const scene = sceneFrom(stateWithLiveRun(), CONNECTED_ROSTER);
    const runCharacter = scene.characters[0];
    renderScreen({ scene, roster: CONNECTED_ROSTER, selectedId: runCharacter.id });

    expect(screen.getByText("Implement auth")).toBeTruthy();
    expect(screen.getByText("Editing the session reader")).toBeTruthy();
  });
});

describe("the keyboard", () => {
  it("reaches the world's navigation before the world itself", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Back");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("AI connectors");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Agent World settings");
  });

  it("activates the connectors control from the keyboard", async () => {
    const user = userEvent.setup();
    const { onOpenConnectors } = renderScreen();

    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onOpenConnectors).toHaveBeenCalledTimes(1);
  });

  it("reaches every agent in the room by tabbing", async () => {
    const user = userEvent.setup();
    renderScreen();

    const names: (string | null)[] = [];
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      names.push(document.activeElement?.getAttribute("aria-label") ?? null);
    }

    expect(names.some((name) => name?.startsWith("Claude Code — Idle"))).toBe(true);
    expect(names.some((name) => name?.startsWith("Gemini — Idle"))).toBe(true);
  });

  it("closes the view with Escape when nothing is selected", async () => {
    const user = userEvent.setup();
    const { onClose } = renderScreen();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the open detail card first, and only then the view", async () => {
    const user = userEvent.setup();
    const scene = sceneFrom(stateWithLiveRun(), CONNECTED_ROSTER);
    const { onClose, onSelect } = renderScreen({
      scene,
      roster: CONNECTED_ROSTER,
      selectedId: scene.characters[0].id,
    });

    await user.keyboard("{Escape}");
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("selects an agent from its roster chip", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderScreen();

    const roster = screen.getByRole("region", { name: "AGENTS IN THIS WORLD" });
    await user.click(within(roster).getByRole("button", { name: /Claude Code/ }));
    expect(onSelect).toHaveBeenCalledWith("idle:claude-code");
  });
});

describe("narrow screens", () => {
  it("keeps every control's accessible name when its label is hidden", () => {
    // The labels collapse below `sm` via a `hidden sm:inline` span. The names
    // must not go with them, which is why they are `aria-label`s rather than
    // text — a control that is only reachable as "button" on a phone is not
    // reachable.
    renderScreen();
    for (const name of ["Back", "AI connectors", "Agent World settings", "Close Agent World"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("states each control's visible label as part of its accessible name", () => {
    // WCAG 2.5.3: what someone reads has to be inside what a voice control
    // would match.
    renderScreen();
    const connectors = screen.getByRole("button", { name: "AI connectors" });
    expect(connectors.textContent).toContain("AI connectors");

    const settings = screen.getByRole("button", { name: "Agent World settings" });
    expect(settings.getAttribute("aria-label")).toContain(settings.textContent ?? "");
  });

  it("lays the world and its roster out in one scrolling column", () => {
    // Nothing is positioned side by side, so there is no breakpoint at which
    // the roster is pushed off the edge of a phone.
    const { container } = renderScreen();
    expect(container.querySelector(".overflow-y-auto")).not.toBeNull();
  });

  it("wraps the roster rather than overflowing it", () => {
    renderScreen();
    const list = screen.getByRole("region", { name: "AGENTS IN THIS WORLD" }).querySelector("ul");
    expect(list?.className).toContain("flex-wrap");
  });
});

describe("when the world is switched off", () => {
  it("says so instead of showing an empty screen", () => {
    renderScreen({ settings: { enabled: false } });
    expect(screen.getByText("Agent World is turned off")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /office floor/ })).toBeNull();
  });

  it("still offers the way to turn it back on", () => {
    const { onOpenWorldSettings } = renderScreen({ settings: { enabled: false } });
    // The header control and the one in the copy both go to the same place.
    screen.getAllByRole("button", { name: /Agent World settings/ })[1].click();
    expect(onOpenWorldSettings).toHaveBeenCalledTimes(1);
  });
});

describe("the existing world behaviour, preserved", () => {
  it("still honours the chosen theme", () => {
    const settings = { ...DEFAULT_AGENT_WORLD_SETTINGS, themeId: "studio" as const };
    renderScreen({ scene: sceneFrom(emptyAgentState(), UNCONNECTED_ROSTER, settings), settings });
    expect(screen.getByRole("group", { name: /studio/i })).toBeTruthy();
  });

  it("still holds everything still when animation is off", () => {
    const { container } = renderScreen({ settings: { animation: "off" } });
    for (const mark of container.querySelectorAll<HTMLElement>(".agent-mark")) {
      expect(mark.style.animationName).toBe("");
    }
  });

  it("still drops idle stand-ins when the user asked for them to be hidden", () => {
    const settings = { ...DEFAULT_AGENT_WORLD_SETTINGS, showIdleAgents: false };
    const scene = sceneFrom(emptyAgentState(), UNCONNECTED_ROSTER, settings);
    renderScreen({ scene, settings });

    expect(screen.getByRole("group", { name: /office floor, empty/ })).toBeTruthy();
  });
});
