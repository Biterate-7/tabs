import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "./app-sidebar";
import type { Workspace } from "@/lib/workspace/types";

function makeWorkspace(over: Partial<Workspace> & { id: string; name: string }): Workspace {
  return {
    tabs: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const workspaces: Workspace[] = [
  makeWorkspace({ id: "w1", name: "General", tabs: [{ id: "t1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com" }] }),
  makeWorkspace({ id: "w2", name: "Research" }),
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  const onSwitch = vi.fn();
  const onToggleCollapsed = vi.fn();
  render(
    <AppSidebar
      workspaces={workspaces}
      currentId="w1"
      relationshipCounts={{}}
      collapsed={false}
      onToggleCollapsed={onToggleCollapsed}
      mobileOpen={false}
      onMobileOpenChange={vi.fn()}
      onSwitch={onSwitch}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onImportFile={vi.fn()}
      onOpenGraph={vi.fn()}
      {...overrides}
    />
  );
  return { onSwitch, onToggleCollapsed };
}

describe("AppSidebar", () => {
  it("keeps the existing workspace switcher reachable by its established label", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: "Switch workspace" })).toBeTruthy();
  });

  it("shows the current workspace's tab count", () => {
    renderSidebar();
    expect(screen.getByText("1 tab")).toBeTruthy();
  });

  it("switches workspace when a space row is clicked", async () => {
    const user = userEvent.setup();
    const { onSwitch } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "Switch to Research" }));

    expect(onSwitch).toHaveBeenCalledWith("w2");
  });

  it("toggles collapsed state via the collapse button", async () => {
    const user = userEvent.setup();
    const { onToggleCollapsed } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it("hides the brand label and metadata line while collapsed but keeps the switcher reachable", () => {
    renderSidebar({ collapsed: true });

    expect(screen.queryByText("TabDump")).toBeNull();
    expect(screen.getByRole("button", { name: "Switch workspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });

  it("opens Graph View from the sidebar", async () => {
    const user = userEvent.setup();
    const onOpenGraph = vi.fn();
    renderSidebar({ onOpenGraph });

    await user.click(screen.getByRole("button", { name: "Open Graph View" }));

    expect(onOpenGraph).toHaveBeenCalledOnce();
  });

  it("shows full labels inside the mobile drawer even when the desktop rail is collapsed", () => {
    renderSidebar({ collapsed: true, mobileOpen: true });

    expect(screen.getByText("TabDump")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close sidebar" })).toBeTruthy();
  });

  it("closes the mobile drawer via its own close control without touching the desktop collapse toggle", async () => {
    const user = userEvent.setup();
    const onMobileOpenChange = vi.fn();
    const { onToggleCollapsed } = renderSidebar({ mobileOpen: true, onMobileOpenChange });

    await user.click(screen.getByRole("button", { name: "Close sidebar" }));

    expect(onMobileOpenChange).toHaveBeenCalledWith(false);
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });
});
