import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import { createAgent } from "@/lib/agents/registry";
import { createRun } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { resetAgentVisualIdentitySeeding } from "@/lib/agents/visual/app-identities";
import {
  clearAgentVisualIdentities,
  registerAgentVisualIdentity,
} from "@/lib/agents/visual/registry";
import { buildWorldScene } from "@/lib/agents/world/scene";
import { DEFAULT_AGENT_WORLD_SETTINGS } from "@/lib/agents/world/settings";
import { AgentWorld } from "./agent-world";
import { AgentActivityList } from "./agent-activity-list";
import { AgentIdentity } from "./agent-identity";
import type { AgentVisualIdentity } from "@/lib/agents/visual/types";

/**
 * Adding a provider, end to end.
 *
 * Brief §23 asks that a new connector require metadata, a mark, an identity,
 * an optional character and animation definitions — and that it require
 * **no** change to the Agent World, the activity feed, the execution UI, the
 * workflow UI, the agent cards or the settings UI.
 *
 * This test is that claim, executed. It registers a provider that does not
 * exist in any catalogue, puts a run against it through the real scene
 * builder, and renders it through the real components. Nothing below imports
 * a provider-specific module, and no component was modified to make it pass.
 */

const T0 = 1_700_000_000_000;

const NEW_PROVIDER = "acme-agent";

const NEW_IDENTITY: AgentVisualIdentity = {
  // `custom` is the union's escape hatch; the registry keys on the string it
  // is given, which is what lets a provider outside the shipped union work.
  id: "custom",
  displayName: "Acme Agent",
  icon: ({ size, title }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      <path d="M4 20 12 4l8 16Z" data-agent-orbit />
    </svg>
  ),
  accentColor: "#ff8800",
  animations: {
    working: { keyframes: "agent-work-climb", durationMs: 1700, iterations: "infinite" },
  },
  character: { silhouette: "chevron", scale: 1.1, accessory: "spark" },
};

afterEach(() => {
  clearAgentVisualIdentities();
  resetAgentVisualIdentitySeeding();
});

function register(): void {
  registerAgentVisualIdentity({ ...NEW_IDENTITY, id: NEW_PROVIDER as AgentVisualIdentity["id"] });
}

function stateWithNewProviderRun() {
  const agent = createAgent(emptyAgentState(), { provider: NEW_PROVIDER, name: "Acme Agent" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  const run = createRun(
    agent.state,
    { agentId: agent.agent.id, workspaceId: "wA", title: "Investigate flake" },
    T0
  );
  if (!run.ok) throw new Error("fixture failed");
  return run.state;
}

describe("a provider this build has never shipped", () => {
  it("renders through AgentIdentity with no component change", () => {
    register();
    render(<AgentIdentity connector={NEW_PROVIDER} />);
    expect(screen.getByText("Acme Agent")).toBeTruthy();
  });

  it("appears in the activity list with its own mark", () => {
    register();
    const { container } = render(
      <AgentActivityList
        items={[
          {
            id: "run:1",
            provider: NEW_PROVIDER,
            agentName: "Acme Agent",
            state: "working",
            activity: "Investigating a flake",
          },
        ]}
      />
    );

    expect(screen.getByText("Acme Agent")).toBeTruthy();
    expect(
      container.querySelector(`.agent-mark[data-agent-provider="${NEW_PROVIDER}"]`)
    ).not.toBeNull();
  });

  it("gets a character in the world, placed and labelled like any other", () => {
    register();
    const scene = buildWorldScene({
      index: buildAgentDomainIndex(stateWithNewProviderRun()),
      workspaceId: "wA",
      settings: DEFAULT_AGENT_WORLD_SETTINGS,
      now: T0 + 1000,
    });

    expect(scene.characters).toHaveLength(1);
    // Its identity's silhouette reached the scene without the world knowing
    // who the provider is.
    expect(scene.characters[0].character.silhouette).toBe("chevron");

    render(
      <AgentWorld
        scene={scene}
        settings={DEFAULT_AGENT_WORLD_SETTINGS}
        now={T0 + 1000}
        selectedId={null}
        onSelect={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: /Acme Agent/ })).toBeTruthy();
  });

  it("uses the animation its identity declared", () => {
    register();
    const { container } = render(
      <AgentActivityList
        items={[
          { id: "run:1", provider: NEW_PROVIDER, agentName: "Acme Agent", state: "working" },
        ]}
      />
    );

    const mark = container.querySelector<HTMLElement>(".agent-mark");
    expect(mark?.style.animationName).toBe("agent-work-climb");
  });

  it("still works with no identity registered at all", () => {
    // The unregistered case is the one that has to keep the product running:
    // a provider observed by a build that knew it, opened in one that does
    // not, is ordinary state — not an error.
    const scene = buildWorldScene({
      index: buildAgentDomainIndex(stateWithNewProviderRun()),
      workspaceId: "wA",
      settings: DEFAULT_AGENT_WORLD_SETTINGS,
      now: T0 + 1000,
    });

    render(
      <AgentWorld
        scene={scene}
        settings={DEFAULT_AGENT_WORLD_SETTINGS}
        now={T0 + 1000}
        selectedId={null}
        onSelect={() => {}}
      />
    );

    // Named from the domain's own record, drawn with the fallback mark.
    expect(screen.getByRole("button", { name: /Acme Agent/ })).toBeTruthy();
  });
});
