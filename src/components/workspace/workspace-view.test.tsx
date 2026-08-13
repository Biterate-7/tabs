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

  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
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

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), "_blank", "noopener,noreferrer");
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
