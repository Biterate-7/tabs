import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabInspector } from "./tab-inspector";
import type { GraphNode } from "@/lib/graph/types";
import type { TabDependency } from "@/lib/dependencies/types";

function makeNode(over: Partial<GraphNode["tab"]> & { id: string }): GraphNode {
  return {
    id: over.id,
    workspaceId: "w1",
    workspaceName: "General",
    tab: {
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      domain: "example.com",
      ...over,
    },
  };
}

describe("TabInspector", () => {
  it("renders nothing visible when there is no inspected node", () => {
    render(
      <TabInspector
        open={false}
        onOpenChange={vi.fn()}
        node={null}
        dependencies={[]}
        usedByDeps={[]}
        tree={[]}
        nodeById={new Map()}
        onSelectTab={vi.fn()}
        onOpenTab={vi.fn()}
        onAddDependency={vi.fn()}
        onRemoveDependency={vi.fn()}
        onChangeDependencyType={vi.fn()}
      />
    );

    expect(screen.queryByText("TAB")).toBeNull();
  });

  it("shows the tab's identity and reuses GraphDependencyPanel for its dependency data", () => {
    const node = makeNode({ id: "1", domain: "github.com", title: "GitHub" });
    const child = makeNode({ id: "2", domain: "docs.example.com", title: "Docs" });
    const dependencies: TabDependency[] = [
      { id: "dep-1::2", parentTabId: "1", childTabId: "2", createdAt: 0 },
    ];

    render(
      <TabInspector
        open
        onOpenChange={vi.fn()}
        node={node}
        dependencies={dependencies}
        usedByDeps={[]}
        tree={[]}
        nodeById={new Map([["2", child]])}
        onSelectTab={vi.fn()}
        onOpenTab={vi.fn()}
        onAddDependency={vi.fn()}
        onRemoveDependency={vi.fn()}
        onChangeDependencyType={vi.fn()}
      />
    );

    expect(screen.getByText("TAB")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByText("Workspace: General")).toBeTruthy();
    expect(screen.getByText("Docs")).toBeTruthy();
  });

  it("calls onOpenTab when the header's Open button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    const node = makeNode({ id: "1", domain: "github.com" });

    render(
      <TabInspector
        open
        onOpenChange={vi.fn()}
        node={node}
        dependencies={[]}
        usedByDeps={[]}
        tree={[]}
        nodeById={new Map()}
        onSelectTab={vi.fn()}
        onOpenTab={onOpenTab}
        onAddDependency={vi.fn()}
        onRemoveDependency={vi.fn()}
        onChangeDependencyType={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /Open/ }));
    expect(onOpenTab).toHaveBeenCalledWith("1");
  });
});
