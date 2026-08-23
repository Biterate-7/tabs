import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoOrganizeReview } from "./auto-organize-review";
import type { OrganizationPlan, PendingOrganizePreview } from "@/lib/ai/types";
import type { Tab } from "@/lib/tabs/types";

function makeTab(id: string, title: string): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", title };
}

function makePlan(over: Partial<OrganizationPlan> = {}): OrganizationPlan {
  return {
    summary: "I analyzed 12 tabs and found 2 useful clusters.",
    workspaces: [
      { proposedName: "Physics", reason: "r", tabs: [{ tabId: "t1", reason: "r", confidence: "high" }, { tabId: "t2", reason: "r", confidence: "high" }] },
      { proposedName: "MUN", reason: "r", tabs: [{ tabId: "t3", reason: "r", confidence: "medium" }] },
    ],
    uncertainTabs: [],
    duplicates: [],
    totalTabsConsidered: 12,
    ...over,
  };
}

function makePreview(over: Partial<PendingOrganizePreview> = {}): PendingOrganizePreview {
  return { status: "awaiting", plan: makePlan(), ...over };
}

const tabsById = new Map<string, Tab>([
  ["t1", makeTab("t1", "Physics IA Notes")],
  ["t2", makeTab("t2", "Physics Orbital Mechanics")],
  ["t3", makeTab("t3", "MUN Resolution Draft")],
]);

describe("AutoOrganizeReview", () => {
  it("renders each proposed workspace with its tab count and sample titles", () => {
    render(<AutoOrganizeReview preview={makePreview()} tabsById={tabsById} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Physics")).toBeTruthy();
    expect(screen.getByText("2 tabs")).toBeTruthy();
    expect(screen.getByText(/Physics IA Notes/)).toBeTruthy();
    expect(screen.getByText("MUN")).toBeTruthy();
  });

  it("renders the noopReason message with no Apply button when there is nothing to organize", () => {
    const preview = makePreview({ plan: makePlan({ workspaces: [], noopReason: "I couldn't find a useful organization that would improve your current setup." }) });
    render(<AutoOrganizeReview preview={preview} tabsById={tabsById} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/couldn't find a useful organization/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /apply organization/i })).toBeNull();
  });

  it("renders uncertain tabs with quick-decision suggestion buttons", () => {
    const plan = makePlan({
      uncertainTabs: [
        { tabId: "g1", reason: "r", currentWorkspaceId: "ws-1", currentWorkspaceName: "Inbox", suggestions: [{ workspaceId: "ws-1", name: 'Keep in "Inbox"' }, { name: "Physics" }, { name: "Miscellaneous" }] },
      ],
    });
    const map = new Map(tabsById);
    map.set("g1", makeTab("g1", "a - Google Search"));
    render(<AutoOrganizeReview preview={makePreview({ plan })} tabsById={map} onApply={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("1 uncertain tab")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Physics" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Miscellaneous" })).toBeTruthy();
  });

  it("moves an uncertain tab into a chosen workspace locally, then applies the edited plan", async () => {
    const user = userEvent.setup();
    const plan = makePlan({
      uncertainTabs: [{ tabId: "g1", reason: "r", currentWorkspaceId: "ws-1", currentWorkspaceName: "Inbox", suggestions: [{ name: "Physics" }] }],
    });
    const onApply = vi.fn();
    render(<AutoOrganizeReview preview={makePreview({ plan })} tabsById={tabsById} onApply={onApply} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Physics" }));
    expect(screen.queryByText("1 uncertain tab")).toBeNull();

    await user.click(screen.getByRole("button", { name: /apply organization/i }));
    const editedPlan = onApply.mock.calls[0][0] as OrganizationPlan;
    expect(editedPlan.uncertainTabs).toEqual([]);
    expect(editedPlan.workspaces.find((w) => w.proposedName === "Physics")!.tabs.map((t) => t.tabId)).toContain("g1");
  });

  it("calls onApply and onCancel", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<AutoOrganizeReview preview={makePreview()} tabsById={tabsById} onApply={onApply} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: /apply organization/i }));
    expect(onApply).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("hides Apply/Cancel once resolved", () => {
    for (const status of ["applied", "cancelled", "failed"] as const) {
      const { unmount } = render(<AutoOrganizeReview preview={makePreview({ status })} tabsById={tabsById} onApply={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /apply organization/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
      unmount();
    }
  });

  it("shows the duplicate count without offering any deletion action", () => {
    const plan = makePlan({ duplicates: [{ tabIds: ["t1", "t4"], reason: "2 copies" }] });
    render(<AutoOrganizeReview preview={makePreview({ plan })} tabsById={tabsById} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/1 likely duplicate tab group/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});
