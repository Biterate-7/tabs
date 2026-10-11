import { beforeEach, describe, expect, it, vi } from "vitest";
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
  makeWorkspace({ id: "w1", name: "History HL", tabs: [{ id: "t1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com" }] }),
  makeWorkspace({ id: "w2", name: "Math AA HL" }),
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  const onSwitch = vi.fn();
  const onToggleCollapsed = vi.fn();
  const onCreate = vi.fn();
  render(
    <AppSidebar
      workspaces={workspaces}
      currentId="w1"
      collapsed={false}
      onToggleCollapsed={onToggleCollapsed}
      mobileOpen={false}
      onMobileOpenChange={vi.fn()}
      onSwitch={onSwitch}
      onCreate={onCreate}
      onOpenFavorites={vi.fn()}
      onOpenRecents={vi.fn()}
      onOpenHistoryDump={vi.fn()}
      onOpenGraph={vi.fn()}
      onOpenCommandCentre={vi.fn()}
      onOpenAgentHistory={vi.fn()}
      onOpenSettings={vi.fn()}
      {...overrides}
    />
  );
  return { onSwitch, onToggleCollapsed, onCreate };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("AppSidebar", () => {
  it("leads with Home, AI and the subjects themselves", () => {
    renderSidebar({ onOpenHome: vi.fn(), onOpenAI: vi.fn() });

    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "AI" })).toBeTruthy();
    const subjects = screen.getByRole("navigation", { name: "Subjects" });
    expect(subjects.textContent).toContain("History HL");
    expect(subjects.textContent).toContain("Math AA HL");
  });

  it("opens a subject when its row is clicked", async () => {
    const user = userEvent.setup();
    const onOpenSubject = vi.fn();
    renderSidebar({ onOpenSubject });

    await user.click(screen.getByRole("button", { name: "Open Math AA HL" }));

    expect(onOpenSubject).toHaveBeenCalledWith("w2");
  });

  it("without onOpenSubject, a row switches and opens the workspace (the landing demo)", async () => {
    const user = userEvent.setup();
    const onOpenWorkspace = vi.fn();
    const { onSwitch } = renderSidebar({ onOpenWorkspace });

    await user.click(screen.getByRole("button", { name: "Open Math AA HL" }));

    expect(onSwitch).toHaveBeenCalledWith("w2");
    expect(onOpenWorkspace).toHaveBeenCalledOnce();
  });

  it("marks the open subject as the current page only while its page is on screen", () => {
    renderSidebar({ currentView: "workspace" });
    expect(screen.getByRole("button", { name: "Open History HL" }).getAttribute("aria-current")).toBe("page");
  });

  it("does not mark a subject current while Home is on screen", () => {
    renderSidebar({ currentView: "home", onOpenHome: vi.fn() });
    expect(screen.getByRole("button", { name: "Open History HL" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
  });

  it("makes a new subject from the rail's + and its dialog", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderSidebar();

    // The section's "+" (the row beneath it opens the same dialog).
    await user.click(screen.getAllByRole("button", { name: "New subject" })[0]!);
    await user.type(await screen.findByLabelText("Subject name"), "Physics SL");
    await user.click(screen.getByRole("button", { name: "Create subject" }));

    expect(onCreate).toHaveBeenCalledWith("Physics SL", undefined);
  });

  it("keeps power tools under More, closed by default", async () => {
    const user = userEvent.setup();
    const onOpenCommandCentre = vi.fn();
    renderSidebar({ onOpenCommandCentre });

    expect(screen.queryByRole("button", { name: "AI chats" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "AI chats" }));

    expect(onOpenCommandCentre).toHaveBeenCalledOnce();
  });

  it("opens More on its own while one of its destinations is on screen", () => {
    renderSidebar({ currentView: "agent-history" });
    expect(screen.getByRole("button", { name: "AI activity" }).getAttribute("aria-current")).toBe("page");
  });

  it("remembers More being opened", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(window.localStorage.getItem("hubble:sidebar-more:v1")).toBe("1");
  });

  it("toggles collapsed state via the collapse button", async () => {
    const user = userEvent.setup();
    const { onToggleCollapsed } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it("hides labels while collapsed but keeps every destination reachable by name", () => {
    renderSidebar({ collapsed: true });

    expect(screen.queryByText("Hubble")).toBeNull();
    expect(screen.queryByText("History HL")).toBeNull();
    expect(screen.getByRole("button", { name: "Open History HL" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Graph" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });

  it("opens Graph View from More", async () => {
    const user = userEvent.setup();
    const onOpenGraph = vi.fn();
    renderSidebar({ onOpenGraph });

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Graph" }));

    expect(onOpenGraph).toHaveBeenCalledOnce();
  });

  it("opens Import from history (History Dump) from More", async () => {
    const user = userEvent.setup();
    const onOpenHistoryDump = vi.fn();
    renderSidebar({ onOpenHistoryDump });

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Import from history" }));

    expect(onOpenHistoryDump).toHaveBeenCalledOnce();
  });

  it("opens Settings from the sidebar", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderSidebar({ onOpenSettings });

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows full labels inside the mobile drawer even when the desktop rail is collapsed", () => {
    renderSidebar({ collapsed: true, mobileOpen: true });

    expect(screen.getByText("Hubble")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close sidebar" })).toBeTruthy();
  });

  it("closes the mobile drawer after navigating from it", async () => {
    const user = userEvent.setup();
    const onMobileOpenChange = vi.fn();
    const onOpenHome = vi.fn();
    renderSidebar({ mobileOpen: true, onMobileOpenChange, onOpenHome });

    await user.click(screen.getByRole("button", { name: "Home" }));

    expect(onOpenHome).toHaveBeenCalledOnce();
    expect(onMobileOpenChange).toHaveBeenCalledWith(false);
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

describe("AppSidebar positioning", () => {
  it("is the window's fixed rail in the app", () => {
    renderSidebar();
    const aside = screen.getByRole("complementary");
    expect(aside.className).toMatch(/\bfixed\b/);
    expect(aside.className).toMatch(/\bh-screen\b/);
    expect(aside.className).toMatch(/md:sticky/);
  });

  it("embedded, positions against its container instead of the viewport", () => {
    renderSidebar({ embedded: true, mobileOpen: true });
    const aside = screen.getByRole("complementary");
    expect(aside.className).toMatch(/\babsolute\b/);
    expect(aside.className).toMatch(/\bh-full\b/);
    expect(aside.className).toMatch(/md:relative/);
    expect(aside.className).not.toMatch(/\bfixed\b|\bh-screen\b|md:sticky/);
    // The drawer's scrim stays inside the container too.
    const scrim = [...document.querySelectorAll("div[aria-hidden]")].find((el) => el.className.includes("bg-(--overlay)"));
    expect(scrim?.className).toMatch(/\babsolute\b/);
  });
});
