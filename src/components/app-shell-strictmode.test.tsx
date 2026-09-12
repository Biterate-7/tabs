import { describe, expect, it, beforeEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

/**
 * Guards the class of bug Phase 2 hit: a React state updater that also
 * persisted and read the clock.
 *
 * React makes no promise about how many times it calls an updater — under
 * StrictMode in development it deliberately calls it twice and keeps one
 * result. An updater that wrote to localStorage therefore wrote twice, and
 * one that called the clock minted two timestamps and kept whichever React
 * kept. Phase 2 observed exactly that, as a 1ms divergence between committed
 * state and stored state that disappeared in a production build.
 *
 * These tests render the real AppShell inside <StrictMode>, so the
 * double-invocation genuinely happens, and assert on the persistence seam
 * itself — a spy on saveWorkspaceStore — rather than on a sleep or a timing
 * window.
 */

const saveSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workspace/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace/persistence")>();
  return {
    ...actual,
    saveWorkspaceStore: (store: WorkspaceStore) => {
      saveSpy(store);
      return actual.saveWorkspaceStore(store);
    },
  };
});

// Imported after the (hoisted) mock factory, so this is the mocked module —
// seeding below therefore also runs through the spy, and every test clears it
// once hydration has settled.
const { saveWorkspaceStore, loadWorkspaceStore } = await import("@/lib/workspace/persistence");

const SEED_TIME = 1_700_000_000_000;

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    ...over,
  };
}

function makeSection(over: Partial<Section> & { id: string; name: string }): Section {
  return { parentId: null, source: "ai", createdAt: SEED_TIME, updatedAt: SEED_TIME, ...over };
}

/**
 * A workspace whose sections already match its tabs' categories, so the
 * load-time healer (syncSectionsWithCategories) has nothing to fix and cannot
 * contribute writes of its own to the counts below.
 */
function seedSettledStore(): void {
  const workspace: Workspace = {
    id: "w1",
    name: "General",
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    sections: [makeSection({ id: "sec-projects", name: "Projects" })],
    tabs: [
      makeTab({ id: "t1", domain: "github.example", url: "https://github.example", category: "projects", sectionId: "sec-projects" }),
      makeTab({ id: "t2", domain: "gitlab.example", url: "https://gitlab.example", category: "projects", sectionId: "sec-projects" }),
    ],
  };
  saveWorkspaceStore({ version: 1, currentId: "w1", workspaces: [workspace] });
}

/** Renders under StrictMode, settles hydration, then forgets its writes. */
async function renderSettled() {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <AppShell />
    </StrictMode>
  );
  await screen.findByPlaceholderText("Search tabs...");
  saveSpy.mockClear();
  return user;
}

/** One logical mutation: recategorize a single tab. */
async function recategorizeOneTab(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText("Search tabs..."), "github.example");
  await user.click(await screen.findByRole("button", { name: /Change category for github\.example/ }));
  await user.click(await screen.findByText("News"));
}

beforeEach(() => {
  window.localStorage.clear();
  saveSpy.mockClear();
});

describe("persistence seam under StrictMode", () => {
  it("persists exactly once for one logical mutation", async () => {
    seedSettledStore();
    const user = await renderSettled();

    await recategorizeOneTab(user);

    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    // The assertion that would have failed before this refactor: the updater
    // ran twice, so the save nested inside it ran twice.
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("does not let a double-evaluated update diverge from what was stored", async () => {
    seedSettledStore();
    const user = await renderSettled();

    await recategorizeOneTab(user);
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());

    // Every write must have carried an identical store, and localStorage must
    // agree with it. A clock read inside an updater produced two stores a
    // millisecond apart, and the one React discarded could still be the one
    // that reached localStorage.
    const written = saveSpy.mock.calls.map((call) => JSON.stringify(call[0] as WorkspaceStore));
    expect(new Set(written).size).toBe(1);
    expect(JSON.stringify(loadWorkspaceStore())).toBe(written[0]);
  });

  it("stamps one timestamp per mutation, not one per updater evaluation", async () => {
    seedSettledStore();
    const user = await renderSettled();

    await recategorizeOneTab(user);
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());

    const workspace = loadWorkspaceStore()?.workspaces.find((w) => w.id === "w1");
    const edited = workspace?.tabs.find((t) => t.id === "t1");
    const untouched = workspace?.tabs.find((t) => t.id === "t2");

    expect(edited?.category).toBe("news");
    // The edited tab moved, its creation time did not, and its neighbour was
    // left entirely alone.
    expect(edited?.updatedAt).toBeGreaterThan(SEED_TIME);
    expect(edited?.createdAt).toBe(SEED_TIME);
    expect(untouched?.updatedAt).toBe(SEED_TIME);
    // The workspace and the tab it stamped share one clock read rather than
    // sitting a millisecond apart.
    expect(workspace?.updatedAt).toBe(edited?.updatedAt);
  });

  // The sidebar toggle is device-local UI state rather than workspace data,
  // but it had the same defect: it saved from inside the updater. It is the
  // cheapest path to drive that shape end to end, so it guards the rule
  // directly.
  it("writes the sidebar preference once per toggle", async () => {
    seedSettledStore();
    const user = await renderSettled();

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      await user.click(await screen.findByRole("button", { name: "Collapse sidebar" }));
      await waitFor(() =>
        expect(setItem.mock.calls.filter(([key]) => key === "tabdump:sidebar-collapsed:v1").length).toBeGreaterThan(0)
      );
      const writes = setItem.mock.calls.filter(([key]) => key === "tabdump:sidebar-collapsed:v1");
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toBe("1");
    } finally {
      setItem.mockRestore();
    }
  });

  // The organization merge is the path Phase 2 caught drifting: it read the
  // clock and persisted inside the updater, so the timestamp React kept and
  // the one that reached localStorage could differ by a millisecond.
  it("keeps organization's stamps identical between committed and stored state", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <AppShell />
      </StrictMode>
    );
    await user.type(await screen.findByPlaceholderText(/Paste your tabs/), "https://github.com/a");
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    await user.click(await screen.findByRole("button", { name: /View workspace/ }));
    await screen.findByPlaceholderText("Search tabs...");

    const stored = loadWorkspaceStore();
    const workspace = stored?.workspaces.find((w) => w.id === stored.currentId);
    const placed = (workspace?.tabs ?? []).filter((t) => t.sectionId !== undefined);
    expect(placed.length).toBeGreaterThan(0);

    // One clock read per merge means the tabs a pass stamped carry exactly
    // that pass's workspace updatedAt — never a value a discarded evaluation
    // minted. A dump can run more than one organization pass, so a tab last
    // touched by an earlier one keeps its earlier stamp; what must hold is
    // that no tab is newer than the workspace, and that the pass which ran
    // last shares the workspace's reading exactly.
    for (const tab of placed) {
      expect(tab.updatedAt!).toBeLessThanOrEqual(workspace!.updatedAt);
    }
    expect(placed.some((t) => t.updatedAt === workspace?.updatedAt)).toBe(true);
    // And the last store handed to the persistence seam is the one on disk.
    const written = saveSpy.mock.calls.at(-1)?.[0] as WorkspaceStore | undefined;
    expect(JSON.stringify(stored)).toBe(JSON.stringify(written));
  });

  // The organization merge must reach localStorage once.
  //
  // Deliberately counted rather than compared: when this ran inside the
  // updater it wrote twice, but the two clock reads only *sometimes* straddled
  // a millisecond, so asserting the timestamps differ would pass or fail on
  // timing. The duplicate write itself is unconditional, so counting it is the
  // deterministic signal.
  //
  // Writes are matched by shape with timestamps blanked, which identifies the
  // post-organization store without hard-coding how many writes a whole dump
  // performs — a repeated *identical* write is fine and expected, since
  // StrictMode re-runs the idempotent load-time migration effect on purpose.
  it("persists the organization result exactly once", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <AppShell />
      </StrictMode>
    );
    await user.type(await screen.findByPlaceholderText(/Paste your tabs/), "https://github.com/a");
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    await user.click(await screen.findByRole("button", { name: /View workspace/ }));
    await screen.findByPlaceholderText("Search tabs...");

    const blankTimestamps = (store: WorkspaceStore) =>
      JSON.stringify(store, (key, value) => (key === "createdAt" || key === "updatedAt" ? 0 : value));

    const writes = saveSpy.mock.calls.map((call) => call[0] as WorkspaceStore);
    expect(writes.length).toBeGreaterThan(0);

    // The organized store is the last one written; it must have been written
    // exactly once. Pre-refactor the updater ran twice and so did this write.
    const organized = writes[writes.length - 1];
    const organizedShape = blankTimestamps(organized);
    const matching = writes.filter((store) => blankTimestamps(store) === organizedShape);

    const workspace = organized.workspaces.find((w) => w.id === organized.currentId);
    expect((workspace?.tabs ?? []).some((t) => t.sectionId !== undefined)).toBe(true);
    expect(matching).toHaveLength(1);
  });

  it("persists once for a bulk mutation rather than once per entity", async () => {
    seedSettledStore();
    const user = await renderSettled();

    // "Clear" empties every tab in the workspace in a single action.
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    const confirm = screen.queryByRole("button", { name: /^(Clear|Confirm|Remove|Delete)/ });
    if (confirm) await user.click(confirm);

    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    // Two tabs removed in one action is still one write, not one per tab.
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceStore()?.workspaces.find((w) => w.id === "w1")?.tabs).toHaveLength(0);
  });
});
