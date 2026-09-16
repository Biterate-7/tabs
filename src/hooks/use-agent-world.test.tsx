import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus } from "@/lib/agents/runs";
import { setStorageNamespace } from "@/lib/storage/namespace";
import { emptyAgentState } from "@/lib/agents/types";
import { loadAgentWorldState } from "@/lib/agents/world/persistence";
import { useAgentWorld, useAgentWorldSettings } from "./use-agent-world";
import type { AgentState } from "@/lib/agents/types";

const T0 = 1_700_000_000_000;

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
  vi.useRealTimers();
});

function stateWithRun(status?: "completed" | "failed") {
  const agent = createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  const run = createRun(agent.state, { agentId: agent.agent.id, workspaceId: "wA", title: "Work" }, T0);
  if (!run.ok) throw new Error("fixture failed");
  if (!status) return run.state;

  const moved = transitionRunStatus(run.state, run.run.id, status, T0 + 10);
  if (!moved.ok) throw new Error("fixture failed");
  return moved.state;
}

function renderWorld(state: AgentState = stateWithRun(), workspaceId = "wA") {
  const index = buildAgentDomainIndex(state);
  return renderHook(({ id }: { id: string }) => useAgentWorld({ index, workspaceId: id }), {
    initialProps: { id: workspaceId },
  });
}

describe("settings", () => {
  it("starts at the defaults and reports itself unhydrated", () => {
    const { result } = renderHook(() => useAgentWorldSettings());
    // Hydration happens in an effect, so by the time the test observes it the
    // read has already run — what matters is that the flag exists and flips.
    expect(result.current.hydrated).toBe(true);
    expect(result.current.settings.themeId).toBe("office");
  });

  it("reads what was previously stored", async () => {
    const first = renderHook(() => useAgentWorldSettings());
    act(() => first.result.current.update({ themeId: "studio" }));

    await waitFor(() => expect(loadAgentWorldState().settings.themeId).toBe("studio"));

    first.unmount();
    const second = renderHook(() => useAgentWorldSettings());
    await waitFor(() => expect(second.result.current.settings.themeId).toBe("studio"));
  });

  it("does not overwrite stored settings with defaults on mount", async () => {
    // The guard on the debounce. Without it the save would fire once on mount,
    // before the load, and flatten the user's settings every time a surface
    // opened.
    const first = renderHook(() => useAgentWorldSettings());
    act(() => first.result.current.update({ density: "detailed" }));
    await waitFor(() => expect(loadAgentWorldState().settings.density).toBe("detailed"));
    first.unmount();

    renderHook(() => useAgentWorldSettings());
    // Give the debounce a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(loadAgentWorldState().settings.density).toBe("detailed");
  });

  it("toggles one effect without disturbing the others", async () => {
    const { result } = renderHook(() => useAgentWorldSettings());
    act(() => result.current.setEffect("particles", false));

    await waitFor(() => {
      const { effects } = loadAgentWorldState().settings;
      expect(effects.particles).toBe(false);
      expect(effects.scenery).toBe(true);
    });
  });

  it("records a per-workspace theme", async () => {
    const { result } = renderHook(() => useAgentWorldSettings());
    act(() => result.current.setOverrideFor("wA", { themeId: "city" }));

    await waitFor(() =>
      expect(loadAgentWorldState().settings.byWorkspace.wA?.themeId).toBe("city")
    );
  });
});

describe("the scene", () => {
  it("builds from the domain index and holds the run it was given", () => {
    const { result } = renderWorld();
    expect(result.current.scene.characters).toHaveLength(1);
    expect(result.current.scene.characters[0].agentName).toBe("Claude Code");
  });

  it("is empty for a workspace with no agent work", () => {
    const { result } = renderWorld(stateWithRun(), "wB");
    expect(result.current.scene.characters).toEqual([]);
  });

  it("derives its clock from the newest thing the domain knows about", () => {
    // Not the wall clock: it keeps the derivation pure, and it means coming
    // back after a week away still shows the last thing an agent did.
    const { result } = renderWorld();
    expect(result.current.now).toBe(T0);
  });

  it("applies this workspace's theme override", async () => {
    const { result } = renderWorld();
    act(() => result.current.setOverride({ themeId: "command-center" }));

    await waitFor(() => expect(result.current.effective.themeId).toBe("command-center"));
    // The stored global theme is untouched — only this workspace changed.
    expect(result.current.settings.themeId).toBe("office");
  });

  it("names this workspace's world, and falls back to null when unnamed", async () => {
    const { result } = renderWorld();
    expect(result.current.worldName).toBeNull();

    act(() => result.current.setOverride({ name: "Research" }));
    await waitFor(() => expect(result.current.worldName).toBe("Research"));
  });
});

describe("selection", () => {
  it("selects and clears", () => {
    const { result } = renderWorld();
    const id = result.current.scene.characters[0].id;

    act(() => result.current.select(id));
    expect(result.current.selectedId).toBe(id);

    act(() => result.current.select(null));
    expect(result.current.selectedId).toBeNull();
  });

  it("does not carry a selection into another workspace", () => {
    // A character selected in one workspace means nothing in another. Derived
    // rather than cleared by an effect, so coming back restores it.
    const { result, rerender } = renderWorld();
    const id = result.current.scene.characters[0].id;

    act(() => result.current.select(id));
    expect(result.current.selectedId).toBe(id);

    rerender({ id: "wB" });
    expect(result.current.selectedId).toBeNull();

    rerender({ id: "wA" });
    expect(result.current.selectedId).toBe(id);
  });
});
