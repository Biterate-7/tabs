import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryGrid } from "./category-grid";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "id",
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "projects",
    ...over,
  };
}

describe("CategoryGrid", () => {
  it("reports the sheet opening when a category card is opened", async () => {
    const onSheetOpenChange = vi.fn();
    const user = userEvent.setup();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];

    render(
      <CategoryGrid tabs={tabs} onCategoryChange={vi.fn()} workspaceId="ws-1" onSheetOpenChange={onSheetOpenChange} />
    );

    await user.click(screen.getByRole("button", { name: /view all/i }));

    expect(onSheetOpenChange).toHaveBeenCalledWith(true);
  });

  it("reports the sheet closing when the user closes it", async () => {
    const onSheetOpenChange = vi.fn();
    const user = userEvent.setup();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];

    render(
      <CategoryGrid tabs={tabs} onCategoryChange={vi.fn()} workspaceId="ws-1" onSheetOpenChange={onSheetOpenChange} />
    );

    await user.click(screen.getByRole("button", { name: /view all/i }));
    onSheetOpenChange.mockClear();

    await user.click(screen.getByRole("button", { name: /close/i }));

    expect(onSheetOpenChange).toHaveBeenCalledWith(false);
  });

  /**
   * Regression test: WorkspaceView swaps CategoryGrid out for
   * FilteredTabList (unmounting it, sheet and all) the instant the user
   * starts searching or filtering. Without an unmount cleanup, a sheet left
   * open at that exact moment would never report closing — the parent's
   * "is a category sheet open" flag (which gates lazy AI indexing, see
   * workspace-view.tsx) would stay stuck `true` for the rest of the
   * session, even though nothing showing AI results is reachable anymore.
   */
  it("reports the sheet closing on unmount if it was left open", async () => {
    const onSheetOpenChange = vi.fn();
    const user = userEvent.setup();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];

    const { unmount } = render(
      <CategoryGrid tabs={tabs} onCategoryChange={vi.fn()} workspaceId="ws-1" onSheetOpenChange={onSheetOpenChange} />
    );

    await user.click(screen.getByRole("button", { name: /view all/i }));
    onSheetOpenChange.mockClear();

    unmount();

    expect(onSheetOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not report a spurious close on unmount when no sheet was ever opened", () => {
    const onSheetOpenChange = vi.fn();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];

    const { unmount } = render(
      <CategoryGrid tabs={tabs} onCategoryChange={vi.fn()} workspaceId="ws-1" onSheetOpenChange={onSheetOpenChange} />
    );

    unmount();

    expect(onSheetOpenChange).not.toHaveBeenCalled();
  });
});
