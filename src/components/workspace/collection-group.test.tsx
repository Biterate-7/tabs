import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionGroup } from "./collection-group";
import { TAB_DRAG_MIME_TYPE } from "@/lib/collections/drag";
import type { Collection } from "@/lib/collections/types";
import type { Tab } from "@/lib/tabs/types";

function makeTab(id: string, domain = "example.com"): Tab {
  return { id, url: `https://${domain}/${id}`, normalizedUrl: `https://${domain}/${id}`, domain, category: "other" };
}

function makeCollection(over: Partial<Collection> = {}): Collection {
  return { id: "c1", workspaceId: "ws-1", name: "Physics IA", tabIds: [], createdAt: 0, updatedAt: 0, ...over };
}

function fakeDataTransfer(tabId: string | null) {
  return {
    types: tabId ? [TAB_DRAG_MIME_TYPE] : [],
    getData: () => tabId ?? "",
    setData: () => {},
    dropEffect: "none",
    effectAllowed: "uninitialized",
  } as unknown as DataTransfer;
}

function baseProps(overrides: Partial<React.ComponentProps<typeof CollectionGroup>> = {}) {
  return {
    collection: makeCollection(),
    tabs: [] as Tab[],
    expanded: true,
    onToggleExpanded: vi.fn(),
    onCategoryChange: vi.fn(),
    onRename: vi.fn(),
    onAddTabs: vi.fn(),
    onOpenAll: vi.fn(),
    onDelete: vi.fn(),
    onRemoveTab: vi.fn(),
    otherCollections: [],
    onMoveTab: vi.fn(),
    onDropTab: vi.fn(),
    ...overrides,
  };
}

describe("CollectionGroup drag-and-drop", () => {
  it("calls onDropTab with the collection id and dragged tab id on drop", () => {
    const onDropTab = vi.fn();
    const { container } = render(<CollectionGroup {...baseProps({ onDropTab })} />);
    const dropZone = container.firstElementChild as HTMLElement;

    fireEvent.dragOver(dropZone, { dataTransfer: fakeDataTransfer("tab-1") });
    fireEvent.drop(dropZone, { dataTransfer: fakeDataTransfer("tab-1") });

    expect(onDropTab).toHaveBeenCalledWith("c1", "tab-1");
  });

  it("ignores a drop event that isn't carrying a TabDump tab id", () => {
    const onDropTab = vi.fn();
    const { container } = render(<CollectionGroup {...baseProps({ onDropTab })} />);
    const dropZone = container.firstElementChild as HTMLElement;

    fireEvent.drop(dropZone, { dataTransfer: fakeDataTransfer(null) });

    expect(onDropTab).not.toHaveBeenCalled();
  });
});

describe("CollectionGroup empty state", () => {
  it("shows a call-to-action instead of a tab list when empty", () => {
    render(<CollectionGroup {...baseProps()} />);
    expect(screen.getByText(/No tabs yet\. Drag tabs here/)).toBeTruthy();
  });

  it("clicking 'add tabs' in the empty state fires onAddTabs", async () => {
    const onAddTabs = vi.fn();
    const user = userEvent.setup();
    render(<CollectionGroup {...baseProps({ onAddTabs })} />);

    await user.click(screen.getByRole("button", { name: "add tabs" }));
    expect(onAddTabs).toHaveBeenCalled();
  });
});

describe("CollectionGroup tab rows", () => {
  it("offers Remove from collection and Move to collection on a member tab", async () => {
    const onRemoveTab = vi.fn();
    const onMoveTab = vi.fn();
    const user = userEvent.setup();
    render(
      <CollectionGroup
        {...baseProps({
          collection: makeCollection({ tabIds: ["tab-1"] }),
          tabs: [makeTab("tab-1", "docs.google.com")],
          otherCollections: [{ id: "c2", name: "Chem" }],
          onRemoveTab,
          onMoveTab,
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "More actions for docs.google.com" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from collection" }));
    expect(onRemoveTab).toHaveBeenCalledWith("tab-1");

    await user.click(screen.getByRole("button", { name: "More actions for docs.google.com" }));
    await user.hover(await screen.findByRole("menuitem", { name: "Move to collection" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Chem" }));
    expect(onMoveTab).toHaveBeenCalledWith("tab-1", "c2");
  });

  it("omits the Move to collection submenu when there are no other collections", async () => {
    const user = userEvent.setup();
    render(
      <CollectionGroup
        {...baseProps({
          collection: makeCollection({ tabIds: ["tab-1"] }),
          tabs: [makeTab("tab-1", "docs.google.com")],
          otherCollections: [],
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "More actions for docs.google.com" }));
    expect(screen.queryByRole("menuitem", { name: "Move to collection" })).toBeNull();
  });
});
