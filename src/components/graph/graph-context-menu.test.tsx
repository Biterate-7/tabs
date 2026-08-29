import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GraphContextMenu } from "./graph-context-menu";
import type { GraphNode } from "@/lib/graph/types";

function makeNode(id: string, domain: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://${domain}`, normalizedUrl: `https://${domain}`, domain },
    workspaceId: "ws-1",
    workspaceName: "School",
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof GraphContextMenu>> = {}) {
  return {
    state: { node: makeNode("a", "arxiv.org"), x: 10, y: 10 },
    otherWorkspaces: [],
    dependencyCount: 0,
    collections: [],
    onOpenTab: vi.fn(),
    onOpenNewTab: vi.fn(),
    onCopyUrl: vi.fn(),
    onCopyCleanUrl: vi.fn(),
    onMoveToWorkspace: vi.fn(),
    onLinkTo: vi.fn(),
    onAddDependency: vi.fn(),
    onViewDependencies: vi.fn(),
    onAddToCollection: vi.fn(),
    onGatherNewCollection: vi.fn(),
    onRemove: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("GraphContextMenu collection submenu", () => {
  it("lists the node's workspace collections and calls onAddToCollection", async () => {
    const onAddToCollection = vi.fn();
    const user = userEvent.setup();
    render(
      <GraphContextMenu
        {...baseProps({ collections: [{ id: "c1", name: "Physics IA" }], onAddToCollection })}
      />
    );

    await user.click(screen.getByRole("menuitem", { name: /Add to collection/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Physics IA" }));

    expect(onAddToCollection).toHaveBeenCalledWith("c1");
  });

  it("offers New collection… even with no existing collections", async () => {
    const onGatherNewCollection = vi.fn();
    const user = userEvent.setup();
    render(<GraphContextMenu {...baseProps({ collections: [], onGatherNewCollection })} />);

    await user.click(screen.getByRole("menuitem", { name: /Add to collection/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New collection…" }));

    expect(onGatherNewCollection).toHaveBeenCalled();
  });

  it("renders nothing when state is null", () => {
    const { container } = render(<GraphContextMenu {...baseProps({ state: null })} />);
    expect(container.firstChild).toBeNull();
  });
});
