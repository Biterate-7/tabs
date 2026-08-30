import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GraphNodeNotesView } from "./graph-node-notes-view";
import type { GraphNode } from "@/lib/graph/types";

function makeNode(id: string, domain: string, over: Partial<GraphNode["tab"]> = {}): GraphNode {
  return {
    id,
    tab: { id, url: `https://${domain}`, normalizedUrl: `https://${domain}`, domain, ...over },
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

  it("shows the document title and workspace/domain breadcrumb", () => {
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org", { title: "arXiv" })} onNotesChange={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "arXiv" })).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.tagName.toLowerCase() === "p" && el.textContent === "School / arxiv.org")
    ).toBeTruthy();
  });

  it("falls back to the domain as the title when the tab has no title", () => {
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "arxiv.org" })).toBeTruthy();
  });

  it("shows the real properties for the tab: title, url, and workspace", () => {
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org", { title: "arXiv" })} onNotesChange={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Properties")).toBeTruthy();
    expect(screen.getByText("title")).toBeTruthy();
    expect(screen.getByText("url")).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.tagName.toLowerCase() === "span" && el.textContent === "https://arxiv.org")
    ).toBeTruthy();
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.getByText("School")).toBeTruthy();
  });

  it("shows a category property only when the tab has one", () => {
    const { rerender } = render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.queryByText("category")).toBeNull();

    rerender(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", { category: "research" })} onNotesChange={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.getByText("category")).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.tagName.toLowerCase() === "span" && el.textContent === "Research")
    ).toBeTruthy();
  });

  it("shows a 'Start writing…' placeholder for a tab with no note", () => {
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={vi.fn()} onClose={vi.fn()} />);
    const textarea = screen.getByPlaceholderText("Start writing…") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("shows the existing note text for a tab that already has one", () => {
    render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", { notes: "Read this later" })} onNotesChange={vi.fn()} onClose={vi.fn()} />
    );
    expect((screen.getByPlaceholderText("Start writing…") as HTMLTextAreaElement).value).toBe("Read this later");
  });

  it("autosaves the trimmed draft through onNotesChange after the debounce window", () => {
    const onNotesChange = vi.fn();
    render(<GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={onNotesChange} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Start writing…"), {
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

    fireEvent.change(screen.getByPlaceholderText("Start writing…"), { target: { value: "Via back" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));

    expect(onNotesChange).toHaveBeenCalledWith("a", "Via back");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onNotesChange when the draft is unchanged", () => {
    const onNotesChange = vi.fn();
    render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", { notes: "Existing" })} onNotesChange={onNotesChange} onClose={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));
    expect(onNotesChange).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only draft as an empty note", () => {
    const onNotesChange = vi.fn();
    render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org", { notes: "Existing" })} onNotesChange={onNotesChange} onClose={vi.fn()} />
    );

    fireEvent.change(screen.getByPlaceholderText("Start writing…"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Back to graph" }));

    expect(onNotesChange).toHaveBeenCalledWith("a", "");
  });

  it("flushes an unsaved draft on unmount (e.g. switching to a different node)", () => {
    const onNotesChange = vi.fn();
    const { unmount } = render(
      <GraphNodeNotesView node={makeNode("a", "arxiv.org")} onNotesChange={onNotesChange} onClose={vi.fn()} />
    );

    fireEvent.change(screen.getByPlaceholderText("Start writing…"), { target: { value: "Unsaved" } });
    unmount();

    expect(onNotesChange).toHaveBeenCalledWith("a", "Unsaved");
  });
});
