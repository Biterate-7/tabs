import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceView } from "./workspace-view";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "id",
    url: over.url ?? "https://example.com",
    normalizedUrl: over.url ?? "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

const tabs: Tab[] = [
  makeTab({ id: "1", url: "https://github.com/a", domain: "github.com", category: "projects" }),
  makeTab({ id: "2", url: "https://arxiv.org/abs/1", domain: "arxiv.org", category: "research" }),
  makeTab({ id: "3", url: "https://www.amazon.in/dp/x", domain: "amazon.in", category: "shopping" }),
];

function renderWorkspace(initialTabs = tabs) {
  const onTabsChange = vi.fn();
  const onClear = vi.fn();
  render(<WorkspaceView tabs={initialTabs} onTabsChange={onTabsChange} onClear={onClear} />);
  return { onTabsChange, onClear };
}

describe("WorkspaceView search/filter/sort", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let locationAssignMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    // openTab's default (no extension connected) navigates the current tab
    // via window.location.assign — jsdom's real assign attempts an
    // unimplemented navigation, so it needs stubbing just like window.open.
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

  it("shows the category grid by default (no query, filter, or sort active)", () => {
    renderWorkspace();
    expect(
      screen.getAllByRole("button", { name: /^View all/ }).length
    ).toBeGreaterThan(0);
  });

  it("searching narrows to a flat matching list", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");

    expect(screen.getAllByText("github.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("arxiv.org")).toBeFalsy();
  });

  it("searching by category display name matches", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "research");

    expect(screen.getAllByText("arxiv.org").length).toBeGreaterThan(0);
    expect(screen.queryByText("github.com")).toBeFalsy();
  });

  it("shows the exact empty state copy for a non-matching search", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "zzznonsense");

    expect(screen.getByText("Nothing matches.")).toBeTruthy();
    expect(
      screen.getByText("Try a different search, or clear your filters.")
    ).toBeTruthy();
  });

  it("clearing the search (X button) returns to the grid", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const input = screen.getByPlaceholderText("Search tabs...");
    await user.type(input, "github");
    await user.click(screen.getByLabelText("Clear search"));

    expect((input as HTMLInputElement).value).toBe("");
    expect(
      screen.getAllByRole("button", { name: /^View all/ }).length
    ).toBeGreaterThan(0);
  });

  it("filtering by category pill shows only that category, combined with search", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: /^Shopping/ }));
    expect(screen.getAllByText("amazon.in").length).toBeGreaterThan(0);
    expect(screen.queryByText("github.com")).toBeFalsy();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "amazon");
    expect(screen.getAllByText("amazon.in").length).toBeGreaterThan(0);

    await user.clear(screen.getByPlaceholderText("Search tabs..."));
    await user.type(screen.getByPlaceholderText("Search tabs..."), "arxiv");
    expect(screen.getByText("Nothing matches.")).toBeTruthy();
  });

  it("Escape clears the search and blurs the input", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const input = screen.getByPlaceholderText("Search tabs...");
    await user.type(input, "github");
    expect(screen.queryByText("View all")).toBeFalsy();

    await user.keyboard("{Escape}");

    expect((input as HTMLInputElement).value).toBe("");
    expect(
      screen.getAllByRole("button", { name: /^View all/ }).length
    ).toBeGreaterThan(0);
  });

  it("Cmd/Ctrl+K opens the command palette from anywhere on the page", async () => {
    renderWorkspace();
    expect(screen.queryByPlaceholderText(/type a command/i)).toBeFalsy();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByPlaceholderText(/type a command/i)).toBeTruthy();
  });

  it("ArrowDown/ArrowUp move the highlight and Enter opens the highlighted tab", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const input = screen.getByPlaceholderText("Search tabs...");
    await user.type(input, "a"); // matches github.com, arxiv.org, amazon.in (domain contains "a")

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    // Enter on a highlighted result reuses the current tab (same as clicking
    // a saved tab card), so it navigates in place rather than opening a new
    // browser tab.
    expect(locationAssignMock).toHaveBeenCalledTimes(1);
    expect(locationAssignMock).toHaveBeenCalledWith(expect.any(String));
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("clicking a saved tab card's Open button navigates the current tab in place, not a new one", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(screen.getByRole("button", { name: "Open github.com" }));

    expect(locationAssignMock).toHaveBeenCalledTimes(1);
    expect(locationAssignMock).toHaveBeenCalledWith("https://github.com/a");
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("WorkspaceView cleanup (Phase 6)", () => {
  const withDuplicate: Tab[] = [
    ...tabs,
    makeTab({ id: "4", url: "https://github.com/a", domain: "github.com", category: "projects", isDuplicate: true }),
  ];

  it("Cleanup opens the review dialog and does NOT delete anything on click", async () => {
    const user = userEvent.setup();
    const onTabsChange = vi.fn();
    render(
      <WorkspaceView tabs={withDuplicate} onTabsChange={onTabsChange} onClear={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: /Cleanup/ }));

    expect(await screen.findByText("Your workspace can be cleaned up.")).toBeTruthy();
    expect(onTabsChange).not.toHaveBeenCalled();
  });

  it("removes duplicates only after review and confirmation", async () => {
    const user = userEvent.setup();
    const onTabsChange = vi.fn();
    render(
      <WorkspaceView tabs={withDuplicate} onTabsChange={onTabsChange} onClear={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: /Cleanup/ }));
    await user.click(await screen.findByRole("button", { name: "Review manually" }));
    await user.click(screen.getByRole("button", { name: "Remove selected (1)" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onTabsChange).toHaveBeenCalledTimes(1);
    const remaining = onTabsChange.mock.calls[0][0] as Tab[];
    expect(remaining.map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(remaining.every((t) => !t.isDuplicate)).toBe(true);
  });
});

describe("WorkspaceView bulk selection", () => {
  it("enters selection mode from a filtered view, selects a row, and shows the toolbar", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByLabelText("Select github.com"));

    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("recategorizes the selection and exits selection mode", async () => {
    const user = userEvent.setup();
    const { onTabsChange } = renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByLabelText("Select github.com"));
    await user.click(screen.getByRole("button", { name: "Recategorize" }));
    await user.click(await screen.findByRole("menuitem", { name: "News" }));

    expect(onTabsChange).toHaveBeenCalledOnce();
    const updated = onTabsChange.mock.calls[0][0] as Tab[];
    expect(updated.find((t) => t.id === "1")?.category).toBe("news");
    expect(screen.queryByText("1 selected")).toBeFalsy();
  });

  it("removes the selection", async () => {
    const user = userEvent.setup();
    const { onTabsChange } = renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByLabelText("Select github.com"));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(onTabsChange).toHaveBeenCalledOnce();
    const remaining = onTabsChange.mock.calls[0][0] as Tab[];
    expect(remaining.map((t) => t.id)).toEqual(["2", "3"]);
  });

  it("clears the selection without changing any tabs", async () => {
    const user = userEvent.setup();
    const { onTabsChange } = renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByLabelText("Select github.com"));
    await user.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(screen.queryByText("1 selected")).toBeFalsy();
    expect(onTabsChange).not.toHaveBeenCalled();
  });

  it("can exit selection mode via Cancel with nothing selected", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
  });
});

describe("WorkspaceView dependency indicator in search results", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let locationAssignMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  function seedDependency(parentTabId: string, childTabId: string) {
    window.localStorage.setItem(
      "tabdump:dependencies:v1",
      JSON.stringify({
        version: 1,
        dependencies: [{ id: `dep-${parentTabId}::${childTabId}`, parentTabId, childTabId, createdAt: 1 }],
      })
    );
  }

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
    window.localStorage.clear();
  });

  it("shows a compact dependency count under a tab that has one, without expanding the item list by default", async () => {
    seedDependency("1", "2"); // github.com (1) depends on arxiv.org (2)
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");

    expect(await screen.findByText("↓ 1 dependency")).toBeTruthy();
    // The expanded per-item list (with the target tab's own label) isn't shown until clicked.
    expect(screen.queryByText("arxiv.org")).toBeFalsy();
  });

  it("does not show an indicator for a tab with no dependency relationships", async () => {
    seedDependency("1", "2");
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "amazon");

    expect(screen.queryByText(/dependenc/)).toBeFalsy();
    expect(screen.queryByText(/used by/)).toBeFalsy();
  });

  it("shows the reverse 'used by' count on the depended-upon tab", async () => {
    seedDependency("1", "2");
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "arxiv");

    expect(await screen.findByText("↑ 1 used by")).toBeTruthy();
  });

  it("expands to show the individual dependency on click, without triggering search/select", async () => {
    seedDependency("1", "2");
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(await screen.findByText("↓ 1 dependency"));

    expect(await screen.findByText("arxiv.org")).toBeTruthy();
    // Expanding is a local toggle, not a navigation — the search box is untouched.
    expect((screen.getByPlaceholderText("Search tabs...") as HTMLInputElement).value).toBe("github");
  });

  it("clicking an expanded dependency item selects it via the existing search behavior", async () => {
    seedDependency("1", "2");
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(await screen.findByText("↓ 1 dependency"));
    await user.click(await screen.findByText("arxiv.org"));

    // The select action is debounced (to give a following double-click a
    // chance to cancel it and open instead — see tab-dependency-indicator.tsx),
    // so it lands slightly after the click itself.
    await screen.findByDisplayValue("https://arxiv.org/abs/1");
    expect(screen.getAllByText("arxiv.org").length).toBeGreaterThan(0);
    expect(screen.queryByText("github.com")).toBeFalsy();
    expect(locationAssignMock).not.toHaveBeenCalled();
  });

  it("double-clicking an expanded dependency item opens it via the existing tab-opening behavior", async () => {
    seedDependency("1", "2");
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");
    await user.click(await screen.findByText("↓ 1 dependency"));
    await user.dblClick(await screen.findByText("arxiv.org"));

    expect(locationAssignMock).toHaveBeenCalledWith("https://arxiv.org/abs/1");
    expect(openSpy).not.toHaveBeenCalled();
    // The double-click must cancel the pending debounced select — the search
    // box should stay untouched, not jump to the dependency's URL.
    expect((screen.getByPlaceholderText("Search tabs...") as HTMLInputElement).value).toBe("github");
  });

  it("safely ignores a stale dependency referencing a tab that no longer exists", async () => {
    window.localStorage.setItem(
      "tabdump:dependencies:v1",
      JSON.stringify({
        version: 1,
        dependencies: [{ id: "dep-1::ghost", parentTabId: "1", childTabId: "ghost", createdAt: 1 }],
      })
    );
    const user = userEvent.setup();
    renderWorkspace();

    await user.type(screen.getByPlaceholderText("Search tabs..."), "github");

    // No crash, and no indicator for a dependency whose target doesn't exist.
    expect(screen.queryByText(/dependenc/)).toBeFalsy();
    expect(screen.getAllByText("github.com").length).toBeGreaterThan(0);
  });
});
