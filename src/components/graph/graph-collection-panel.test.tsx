import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GraphCollectionPanel } from "./graph-collection-panel";
import type { Collection } from "@/lib/collections/types";
import type { GraphNode } from "@/lib/graph/types";

function makeCollection(over: Partial<Collection> = {}): Collection {
  return { id: "c1", workspaceId: "ws-1", name: "Physics IA", tabIds: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeNode(id: string, domain: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://${domain}`, normalizedUrl: `https://${domain}`, domain },
    workspaceId: "ws-1",
    workspaceName: "School",
  };
}

describe("GraphCollectionPanel", () => {
  it("shows an empty state when the collection has no tabs", () => {
    render(
      <GraphCollectionPanel
        collection={makeCollection()}
        nodeById={new Map()}
        onSelectTab={vi.fn()}
        onOpenTab={vi.fn()}
        onFocus={vi.fn()}
        onRename={vi.fn()}
        onOpenAll={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("No tabs yet.")).toBeTruthy();
    expect(screen.getByText("0 tabs")).toBeTruthy();
  });

  it("lists resolved member tabs and calls onSelectTab/onOpenTab", async () => {
    const onSelectTab = vi.fn();
    const onOpenTab = vi.fn();
    const user = userEvent.setup();
    const nodeById = new Map([["a", makeNode("a", "arxiv.org")]]);
    render(
      <GraphCollectionPanel
        collection={makeCollection({ tabIds: ["a"] })}
        nodeById={nodeById}
        onSelectTab={onSelectTab}
        onOpenTab={onOpenTab}
        onFocus={vi.fn()}
        onRename={vi.fn()}
        onOpenAll={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const row = screen.getByText("arxiv.org", { selector: "p.truncate.text-body-sm" });
    await user.click(row);
    expect(onSelectTab).toHaveBeenCalledWith("a");

    await user.dblClick(row);
    expect(onOpenTab).toHaveBeenCalledWith("a");
  });

  it("shows a placeholder for a stale/deleted member id", () => {
    render(
      <GraphCollectionPanel
        collection={makeCollection({ tabIds: ["ghost"] })}
        nodeById={new Map()}
        onSelectTab={vi.fn()}
        onOpenTab={vi.fn()}
        onFocus={vi.fn()}
        onRename={vi.fn()}
        onOpenAll={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("Deleted tab")).toBeTruthy();
  });

  it("wires the action row to its callbacks", async () => {
    const onFocus = vi.fn();
    const onRename = vi.fn();
    const onOpenAll = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <GraphCollectionPanel
        collection={makeCollection({ tabIds: ["a"] })}
        nodeById={new Map([["a", makeNode("a", "arxiv.org")]])}
        onSelectTab={vi.fn()}
        onOpenTab={vi.fn()}
        onFocus={onFocus}
        onRename={onRename}
        onOpenAll={onOpenAll}
        onDelete={onDelete}
      />
    );

    await user.click(screen.getByRole("button", { name: /Focus/ }));
    await user.click(screen.getByRole("button", { name: /Rename/ }));
    await user.click(screen.getByRole("button", { name: /Open all/ }));
    await user.click(screen.getByRole("button", { name: /Delete/ }));

    expect(onFocus).toHaveBeenCalled();
    expect(onRename).toHaveBeenCalled();
    expect(onOpenAll).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });

  it("disables Open all for an empty collection", () => {
    render(
      <GraphCollectionPanel
        collection={makeCollection()}
        nodeById={new Map()}
        onSelectTab={vi.fn()}
        onOpenTab={vi.fn()}
        onFocus={vi.fn()}
        onRename={vi.fn()}
        onOpenAll={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect((screen.getByRole("button", { name: /Open all/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
