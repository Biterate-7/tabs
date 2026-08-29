import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
