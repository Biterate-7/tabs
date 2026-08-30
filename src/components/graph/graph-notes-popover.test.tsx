import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GraphNotesPopover } from "./graph-notes-popover";
import type { GraphNode } from "@/lib/graph/types";

function makeNode(id: string, domain: string, notes?: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://${domain}`, normalizedUrl: `https://${domain}`, domain, notes },
    workspaceId: "ws-1",
    workspaceName: "School",
  };
}

const anchor = { x: 100, y: 100, radius: 12 };

describe("GraphNotesPopover", () => {
  it("renders nothing when there's no target tab", () => {
    const { container } = render(
      <GraphNotesPopover
        tabId={null}
        node={null}
        getAnchor={() => anchor}
        onNotesChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows an 'add a note' placeholder for a tab with no note", () => {
    render(
      <GraphNotesPopover
        tabId="a"
        node={makeNode("a", "arxiv.org")}
        getAnchor={() => anchor}
        onNotesChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const textarea = screen.getByPlaceholderText("Add a note for arxiv.org…") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe("");
  });

  it("shows the existing note text for a tab that already has one", () => {
    render(
      <GraphNotesPopover
        tabId="a"
        node={makeNode("a", "arxiv.org", "Read this later")}
        getAnchor={() => anchor}
        onNotesChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect((screen.getByPlaceholderText("Add a note for arxiv.org…") as HTMLTextAreaElement).value).toBe(
      "Read this later"
    );
  });

  it("commits the trimmed draft and closes when Done is clicked", () => {
    const onNotesChange = vi.fn();
    const onClose = vi.fn();
    render(
      <GraphNotesPopover
        tabId="a"
        node={makeNode("a", "arxiv.org")}
        getAnchor={() => anchor}
        onNotesChange={onNotesChange}
        onClose={onClose}
      />
    );

    const textarea = screen.getByPlaceholderText("Add a note for arxiv.org…");
    fireEvent.change(textarea, { target: { value: "  New note  " } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onNotesChange).toHaveBeenCalledWith("a", "New note");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onNotesChange when the draft is unchanged", () => {
    const onNotesChange = vi.fn();
    render(
      <GraphNotesPopover
        tabId="a"
        node={makeNode("a", "arxiv.org", "Existing")}
        getAnchor={() => anchor}
        onNotesChange={onNotesChange}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onNotesChange).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only draft as an empty note", () => {
    const onNotesChange = vi.fn();
    render(
      <GraphNotesPopover
        tabId="a"
        node={makeNode("a", "arxiv.org", "Existing")}
        getAnchor={() => anchor}
        onNotesChange={onNotesChange}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByPlaceholderText("Add a note for arxiv.org…");
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onNotesChange).toHaveBeenCalledWith("a", "");
  });

  it("commits and closes on Escape", () => {
    const onNotesChange = vi.fn();
    const onClose = vi.fn();
    render(
      <GraphNotesPopover
        tabId="a"
        node={makeNode("a", "arxiv.org")}
        getAnchor={() => anchor}
        onNotesChange={onNotesChange}
        onClose={onClose}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Add a note for arxiv.org…"), {
      target: { value: "Via escape" },
    });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onNotesChange).toHaveBeenCalledWith("a", "Via escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("commits and closes on an outside click, but not on a click inside the panel", () => {
    const onNotesChange = vi.fn();
    const onClose = vi.fn();
    render(
      <div>
        <button type="button">outside</button>
        <GraphNotesPopover
          tabId="a"
          node={makeNode("a", "arxiv.org")}
          getAnchor={() => anchor}
          onNotesChange={onNotesChange}
          onClose={onClose}
        />
      </div>
    );

    fireEvent.change(screen.getByPlaceholderText("Add a note for arxiv.org…"), {
      target: { value: "Draft" },
    });

    // A pointerdown+up inside the panel (the textarea itself) must not close it.
    fireEvent.pointerDown(screen.getByPlaceholderText("Add a note for arxiv.org…"));
    fireEvent.pointerUp(screen.getByPlaceholderText("Add a note for arxiv.org…"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    fireEvent.pointerUp(screen.getByRole("button", { name: "outside" }));
    expect(onNotesChange).toHaveBeenCalledWith("a", "Draft");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on an outside pointerdown that turns into a drag (e.g. panning the canvas)", () => {
    const onNotesChange = vi.fn();
    const onClose = vi.fn();
    render(
      <div>
        <button type="button">outside</button>
        <GraphNotesPopover
          tabId="a"
          node={makeNode("a", "arxiv.org")}
          getAnchor={() => anchor}
          onNotesChange={onNotesChange}
          onClose={onClose}
        />
      </div>
    );

    const outside = screen.getByRole("button", { name: "outside" });
    fireEvent.pointerDown(outside, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(outside, { clientX: 50, clientY: 50 });

    expect(onClose).not.toHaveBeenCalled();
    expect(onNotesChange).not.toHaveBeenCalled();
  });

  it("resets the draft when the target tab changes", () => {
    const { rerender } = render(
      <GraphNotesPopover
        tabId="a"
        node={makeNode("a", "arxiv.org", "Note for a")}
        getAnchor={() => anchor}
        onNotesChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect((screen.getByPlaceholderText("Add a note for arxiv.org…") as HTMLTextAreaElement).value).toBe(
      "Note for a"
    );

    rerender(
      <GraphNotesPopover
        tabId="b"
        node={makeNode("b", "github.com", "Note for b")}
        getAnchor={() => anchor}
        onNotesChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect((screen.getByPlaceholderText("Add a note for github.com…") as HTMLTextAreaElement).value).toBe(
      "Note for b"
    );
  });
});
