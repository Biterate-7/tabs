import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createAgent } from "@/lib/agents/registry";
import { createRun } from "@/lib/agents/runs";
import { buildAgentSpatialScene } from "@/lib/agents/spatial/scene";
import { emptyAgentState } from "@/lib/agents/types";
import { resetAgentVisualIdentitySeeding } from "@/lib/agents/visual/app-identities";
import {
  clearAgentVisualIdentities,
  registerAgentVisualIdentity,
} from "@/lib/agents/visual/registry";
import { AgentActivityList } from "./agent-activity-list";
import { AgentIdentity } from "./agent-identity";
import type { AgentState } from "@/lib/agents/types";
import type { AgentVisualIdentity } from "@/lib/agents/visual/types";

/**
 * Adding a provider, end to end.
 *
 * The architecture's central claim is that a new agent provider requires
 * metadata, a mark and an identity — and **no** change to the activity feed,
 * the agent cards, the spatial scene or the settings UI. This test is that
 * claim, executed: it registers a provider that exists in no catalogue, puts
 * a run against it through the real scene builder, and renders it through the
 * real components. Nothing below imports a provider-specific module, and no
 * component was modified to make it pass.
 *
 * It was previously written against the Agent World, which is gone. What it
 * asserts is unchanged — only the surfaces are, which is itself the point: a
 * surface being deleted did not cost the product its extensibility guarantee,
 * because the guarantee never lived in that surface.
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
      <path d="M4 20 12 4l8 16Z" />
    </svg>
  ),
  accentColor: "#ff8800",
};

afterEach(() => {
  clearAgentVisualIdentities();
  resetAgentVisualIdentitySeeding();
});

function register(): void {
  registerAgentVisualIdentity({ ...NEW_IDENTITY, id: NEW_PROVIDER as AgentVisualIdentity["id"] });
}

function stateWithNewProviderRun(): AgentState {
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

function sceneFor(state: AgentState) {
  return buildAgentSpatialScene(state, {
    agents: state.agents,
    runs: state.runs,
    artifacts: state.artifacts,
    workspaceId: "wA",
    filter: "all",
    now: T0 + 1000,
  });
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

  it("gets a node in the spatial scene, carrying its own provider key", () => {
    register();
    const scene = sceneFor(stateWithNewProviderRun());

    const runNodes = scene.nodes.filter((node) => node.kind === "run");
    expect(runNodes).toHaveLength(1);
    // The provider reached the scene without the scene builder knowing who it
    // is — it is copied off the agent, never matched against a known set.
    expect(runNodes[0]).toMatchObject({ provider: NEW_PROVIDER, label: "Investigate flake" });
  });

  it("still works with no identity registered at all", () => {
    // The unregistered case is the one that has to keep the product running:
    // a provider observed by a build that knew it, opened in one that does
    // not, is ordinary state — not an error.
    const scene = sceneFor(stateWithNewProviderRun());
    const runNode = scene.nodes.find((node) => node.kind === "run");
    expect(runNode).toBeDefined();

    const { container } = render(
      <AgentActivityList
        items={[
          { id: runNode!.id, provider: NEW_PROVIDER, agentName: "Acme Agent", state: "working" },
        ]}
      />
    );

    // Named from the domain's own record, drawn with the fallback mark.
    expect(screen.getByText("Acme Agent")).toBeTruthy();
    expect(container.querySelector(".agent-mark")).not.toBeNull();
  });
});
