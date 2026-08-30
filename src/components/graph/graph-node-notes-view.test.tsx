import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GraphNodeNotesView } from "./graph-node-notes-view";
import type { GraphNode } from "@/lib/graph/types";

function makeNode(id: string, domain: string, notes?: string, title?: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://${domain}`, normalizedUrl: `https://${domain}`, domain, notes, title },
    workspaceId: "ws-1",
    workspaceName: "School",
  };
}

describe("GraphNodeNotesView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("identifies which tab/domain the notes belong to", () => {
    render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", undefined, "arXiv")} onNotesChange={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.getByText("arXiv")).toBeTruthy();
    expect(screen.getByText("arxiv.org")).toBeTruthy();
  });

  it("shows an 'add a note' placeholder for a tab with no note", () => {
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={vi.fn()} onClose={vi.fn()} />);
    const textarea = screen.getByPlaceholderText("Add a note for arxiv.org…") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("shows the existing note text for a tab that already has one", () => {
    render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", "Read this later")} onNotesChange={vi.fn()} onClose={vi.fn()} />
    );
    expect((screen.getByPlaceholderText("Add a note for arxiv.org…") as HTMLTextAreaElement).value).toBe(
      "Read this later"
    );
  });

  it("autosaves the trimmed draft through onNotesChange after the debounce window", () => {
    const onNotesChange = vi.fn();
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={onNotesChange} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Add a note for arxiv.org…"), {
      target: { value: "  New note  " },
    });
    expect(onNotesChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(onNotesChange).toHaveBeenCalledWith("a", "New note");
  });

  it("flushes the pending draft immediately when Back is clicked, and calls onClose", () => {
    const onNotesChange = vi.fn();
    const onClose = vi.fn();
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={onNotesChange} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("Add a note for arxiv.org…"), { target: { value: "Via back" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));

    expect(onNotesChange).toHaveBeenCalledWith("a", "Via back");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onNotesChange when the draft is unchanged", () => {
    const onNotesChange = vi.fn();
    render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", "Existing")} onNotesChange={onNotesChange} onClose={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));
    expect(onNotesChange).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only draft as an empty note", () => {
    const onNotesChange = vi.fn();
    render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", "Existing")} onNotesChange={onNotesChange} onClose={vi.fn()} />
    );

    fireEvent.change(screen.getByPlaceholderText("Add a note for arxiv.org…"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));

    expect(onNotesChange).toHaveBeenCalledWith("a", "");
  });

  it("flushes an unsaved draft on unmount (e.g. switching to a different node)", () => {
    const onNotesChange = vi.fn();
    const { unmount } = render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={onNotesChange} onClose={vi.fn()} />
    );

    fireEvent.change(screen.getByPlaceholderText("Add a note for arxiv.org…"), { target: { value: "Unsaved" } });
    unmount();

    expect(onNotesChange).toHaveBeenCalledWith("a", "Unsaved");
  });
});
