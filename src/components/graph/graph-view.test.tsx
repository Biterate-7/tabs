import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GraphView } from "./graph-view";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://${over.id}.example.com`,
    normalizedUrl: `https://${over.id}.example.com`,
    domain: `${over.id}.example.com`,
    ...over,
  };
}

function makeStore(tabs: Tab[]): WorkspaceStore {
  return {
    version: 1,
    currentId: "w1",
    workspaces: [{ id: "w1", name: "General", tabs, createdAt: 0, updatedAt: 0 }],
  };
}

describe("GraphView", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let locationAssignMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    window.localStorage.clear();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    originalLocation = window.location;
    locationAssignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: locationAssignMock },
    });
  });

  afterEach(() => {
    openSpy.mockRestore();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("shows the empty state when there are no tabs", () => {
    render(<GraphView store={makeStore([])} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("No tabs to visualize yet.")).toBeTruthy();
  });

  it("shows the 'not enough connections' state with exactly one tab", () => {
    render(<GraphView store={makeStore([makeTab({ id: "a" })])} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Not enough connections yet.")).toBeTruthy();
  });

  it("renders the sidebar and back button once there is enough to graph", () => {
    const store = makeStore([
      makeTab({ id: "a", domain: "github.com" }),
      makeTab({ id: "b", domain: "github.com" }),
    ]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText("GRAPH")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to workspace" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search tabs...")).toBeTruthy();
  });

  it("calls onClose when the back button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("prompts for a selection when switching to local view with nothing selected", async () => {
    const user = userEvent.setup();
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Local" }));
    expect(screen.getByText("Select a tab to see its local graph.")).toBeTruthy();
  });

  it("shows a filtered-out message when every connection filter is off", async () => {
    const user = userEvent.setup();
    // Two tabs, same domain, same (only) workspace — domain and workspace
    // filters are both on by default, so both must be turned off to reach
    // zero edges (category/group are off by default; there's no manual link).
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole("checkbox", { name: /same domain/i }));
    await user.click(screen.getByRole("checkbox", { name: /same workspace/i }));

    expect(screen.getByText("No connections match the current filters.")).toBeTruthy();
  });
});

// Seeds the graph's own persisted UI state (camera, selection, etc. — see
// src/lib/graph/persistence.ts) so a node shows up already selected without
// having to click through the canvas's hit-testing, which needs real layout
// geometry jsdom doesn't provide.
function seedSelectedTab(tabId: string) {
  window.localStorage.setItem(
    "tabdump:graph:v1",
    JSON.stringify({
      version: 1,
      positions: {},
      manualConnections: [],
      settings: { selectedTabId: tabId },
    })
  );
}

describe("GraphView dedicated notes page", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  // Opening notes is an explicit action (the sidebar's Notes button, once a
  // node is selected), not something that follows selection automatically —
  // see handleOpenNotes in graph-view.tsx.
  function openNotes() {
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
  }

  it("does not open just from selecting a node, but offers an explicit Notes action", () => {
    seedSelectedTab("a");
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Back to graph" })).toBeNull();
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("opens via the sidebar's Notes button and shows a placeholder when it has no note", () => {
    seedSelectedTab("a");
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);
    openNotes();

    expect(screen.getByRole("button", { name: "Back to graph" })).toBeTruthy();
    expect((screen.getByPlaceholderText("Start writing…") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows a note that already exists on the tab (e.g. added via the tab card)", () => {
    seedSelectedTab("a");
    const store = makeStore([
      makeTab({ id: "a", domain: "github.com", notes: "From the tab card" }),
      makeTab({ id: "b", domain: "github.com" }),
    ]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);
    openNotes();

    expect((screen.getByPlaceholderText("Start writing…") as HTMLTextAreaElement).value).toBe(
      "From the tab card"
    );
  });

  it("adding a note through the graph calls onStoreUpdate with the tab's notes set", () => {
    seedSelectedTab("a");
    const onStoreUpdate = vi.fn();
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={onStoreUpdate} onClose={vi.fn()} />);
    openNotes();

    const textarea = screen.getByPlaceholderText("Start writing…");
    fireEvent.change(textarea, { target: { value: "Check the README" } });
    // Going back flushes the pending debounced save immediately, rather than
    // waiting out SAVE_DEBOUNCE_MS.
    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));

    expect(onStoreUpdate).toHaveBeenCalledTimes(1);
    const next = onStoreUpdate.mock.calls[0][0] as WorkspaceStore;
    expect(next.workspaces[0].tabs.find((t) => t.id === "a")?.notes).toBe("Check the README");
    // The other tab is untouched.
    expect(next.workspaces[0].tabs.find((t) => t.id === "b")?.notes).toBeUndefined();
  });

  it("editing an existing note calls onStoreUpdate with the updated text", () => {
    seedSelectedTab("a");
    const onStoreUpdate = vi.fn();
    const store = makeStore([
      makeTab({ id: "a", domain: "github.com", notes: "Old note" }),
      makeTab({ id: "b", domain: "github.com" }),
    ]);
    render(<GraphView store={store} onStoreUpdate={onStoreUpdate} onClose={vi.fn()} />);
    openNotes();

    const textarea = screen.getByPlaceholderText("Start writing…");
    fireEvent.change(textarea, { target: { value: "Updated note" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));

    const next = onStoreUpdate.mock.calls[0][0] as WorkspaceStore;
    expect(next.workspaces[0].tabs.find((t) => t.id === "a")?.notes).toBe("Updated note");
  });

  it("closing the notes page returns to the graph without touching selection", () => {
    seedSelectedTab("a");
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);
    openNotes();

    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));

    expect(screen.queryByPlaceholderText("Start writing…")).toBeNull();
    expect(screen.getByText("GRAPH")).toBeTruthy();
    // Selection survived the close — the sidebar still shows "a"'s panel, Notes button included.
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("offers no Notes entry point when no node is selected", () => {
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to graph" })).toBeNull();
  });

  it("closes when the tab is removed from the store while its note is open", () => {
    seedSelectedTab("a");
    const store = makeStore([makeTab({ id: "a", domain: "github.com" }), makeTab({ id: "b", domain: "github.com" })]);
    const { rerender } = render(<GraphView store={store} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);
    openNotes();
    expect(screen.getByPlaceholderText("Start writing…")).toBeTruthy();

    const withoutA = makeStore([makeTab({ id: "b", domain: "github.com" })]);
    rerender(<GraphView store={withoutA} onStoreUpdate={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Back to graph" })).toBeNull();
  });
});
