import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskTabDumpPanel } from "./ask-tabdump-panel";
import * as useAskTabDumpModule from "@/hooks/use-ask-tabdump";
import type { Tab } from "@/lib/tabs/types";
import type { AskMessage, PendingActionPreviewStatus, UndoActionStatus } from "@/lib/ai/types";

vi.mock("@/hooks/use-ask-tabdump", () => ({
  useAskTabDump: vi.fn(),
}));

function makeTab(overrides: Partial<Tab> & { id: string; url: string }): Tab {
  return { normalizedUrl: overrides.url, domain: "example.com", category: "other", ...overrides };
}

function mockHook(overrides: {
  messages?: AskMessage[];
  isSending?: boolean;
  send?: (q: string) => void;
  regenerate?: () => void;
  clear?: () => void;
  applyPreview?: (id: string) => Promise<void>;
  cancelPreview?: (id: string) => void;
  applyOrganizePreview?: (id: string, editedPlan?: unknown) => Promise<void>;
  cancelOrganizePreview?: (id: string) => void;
  undoAction?: (id: string) => Promise<void>;
}) {
  vi.mocked(useAskTabDumpModule.useAskTabDump).mockReturnValue({
    messages: overrides.messages ?? [],
    isSending: overrides.isSending ?? false,
    send: overrides.send ?? vi.fn(),
    regenerate: overrides.regenerate ?? vi.fn(),
    clear: overrides.clear ?? vi.fn(),
    applyPreview: overrides.applyPreview ?? vi.fn(async () => {}),
    cancelPreview: overrides.cancelPreview ?? vi.fn(),
    applyOrganizePreview: overrides.applyOrganizePreview ?? vi.fn(async () => {}),
    cancelOrganizePreview: overrides.cancelOrganizePreview ?? vi.fn(),
    undoAction: overrides.undoAction ?? vi.fn(async () => {}),
  });
}

const noIndexing = { isIndexing: false, indexed: 0, total: 0 };

beforeEach(() => {
  vi.mocked(useAskTabDumpModule.useAskTabDump).mockReset();
});

describe("AskTabDumpPanel", () => {
  it("shows the no-tabs empty state when the workspace has no tabs", () => {
    mockHook({});
    render(
      <AskTabDumpPanel open workspaceId="ws-1" tabs={[]} indexState={noIndexing} onOpenChange={vi.fn()} />
    );
    expect(screen.getByText("Dump some tabs first")).toBeTruthy();
  });

  it("shows suggested questions when there are tabs but no conversation yet", () => {
    mockHook({ messages: [] });
    render(
      <AskTabDumpPanel
        open
        workspaceId="ws-1"
        tabs={[makeTab({ id: "1", url: "https://example.com" })]}
        indexState={noIndexing}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText("What did I save recently?")).toBeTruthy();
  });

  it("sends the typed question and clears the input", async () => {
    const send = vi.fn();
    mockHook({ send });
    const user = userEvent.setup();

    render(
      <AskTabDumpPanel
        open
        workspaceId="ws-1"
        tabs={[makeTab({ id: "1", url: "https://example.com" })]}
        indexState={noIndexing}
        onOpenChange={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/ask anything/i);
    await user.type(input, "What did I save about SAT?");
    await user.keyboard("{Enter}");

    expect(send).toHaveBeenCalledWith("What did I save about SAT?");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("renders sources for a completed assistant message", () => {
    mockHook({
      messages: [
        { id: "1", role: "user", text: "What did I save about SAT?" },
        {
          id: "2",
          role: "assistant",
          text: "You saved a few things.",
          sources: [
            { tabId: "t1", title: "SAT Guide", url: "https://collegeboard.org", domain: "collegeboard.org" },
          ],
        },
      ],
    });

    render(
      <AskTabDumpPanel
        open
        workspaceId="ws-1"
        tabs={[makeTab({ id: "1", url: "https://example.com" })]}
        indexState={noIndexing}
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.getByText("You saved a few things.")).toBeTruthy();
    expect(screen.getByText("SAT Guide")).toBeTruthy();
  });

  it("shows the indexing progress note while indexing is in progress", () => {
    mockHook({});
    render(
      <AskTabDumpPanel
        open
        workspaceId="ws-1"
        tabs={[makeTab({ id: "1", url: "https://example.com" })]}
        indexState={{ isIndexing: true, indexed: 3, total: 10 }}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText(/Indexing your tabs… 3\/10/)).toBeTruthy();
  });

  describe("action preview", () => {
    function messagesWithPreview(status: PendingActionPreviewStatus): AskMessage[] {
      return [
        { id: "1", role: "user" as const, text: "Organize this workspace." },
        {
          id: "2",
          role: "assistant" as const,
          text: "Here's what I want to change",
          preview: {
            status,
            summary: "This will create 2 groups and move 13 tabs.",
            plan: [
              { name: "create_group", args: {}, label: 'Create group → "Physics IA"', affected: 1 },
              { name: "move_tabs", args: {}, label: 'Move 13 tabs → "Research"', affected: 13 },
            ],
          },
        },
      ];
    }

    it("renders every proposed action plus the summary, with Apply/Cancel buttons, while awaiting approval", () => {
      mockHook({ messages: messagesWithPreview("awaiting") });
      render(
        <AskTabDumpPanel
          open
          workspaceId="ws-1"
          tabs={[makeTab({ id: "1", url: "https://example.com" })]}
          indexState={noIndexing}
          onOpenChange={vi.fn()}
        />
      );

      expect(screen.getByText('Create group → "Physics IA"')).toBeTruthy();
      expect(screen.getByText('Move 13 tabs → "Research"')).toBeTruthy();
      expect(screen.getByText("This will create 2 groups and move 13 tabs.")).toBeTruthy();
      expect(screen.getByRole("button", { name: /apply changes/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
    });

    it("calls applyPreview with the message id when Apply changes is clicked", async () => {
      const applyPreview = vi.fn(async () => {});
      mockHook({ messages: messagesWithPreview("awaiting"), applyPreview });
      const user = userEvent.setup();

      render(
        <AskTabDumpPanel
          open
          workspaceId="ws-1"
          tabs={[makeTab({ id: "1", url: "https://example.com" })]}
          indexState={noIndexing}
          onOpenChange={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: /apply changes/i }));
      expect(applyPreview).toHaveBeenCalledWith("2");
    });

    it("calls cancelPreview with the message id when Cancel is clicked", async () => {
      const cancelPreview = vi.fn();
      mockHook({ messages: messagesWithPreview("awaiting"), cancelPreview });
      const user = userEvent.setup();

      render(
        <AskTabDumpPanel
          open
          workspaceId="ws-1"
          tabs={[makeTab({ id: "1", url: "https://example.com" })]}
          indexState={noIndexing}
          onOpenChange={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: /^cancel$/i }));
      expect(cancelPreview).toHaveBeenCalledWith("2");
    });

    it("disables Apply while an apply is in flight", () => {
      mockHook({ messages: messagesWithPreview("applying") });
      render(
        <AskTabDumpPanel
          open
          workspaceId="ws-1"
          tabs={[makeTab({ id: "1", url: "https://example.com" })]}
          indexState={noIndexing}
          onOpenChange={vi.fn()}
        />
      );

      expect((screen.getByRole("button", { name: /apply changes/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("hides the Apply/Cancel buttons once the preview has been resolved (applied)", () => {
      mockHook({ messages: messagesWithPreview("applied") });
      render(
        <AskTabDumpPanel
          open
          workspaceId="ws-1"
          tabs={[makeTab({ id: "1", url: "https://example.com" })]}
          indexState={noIndexing}
          onOpenChange={vi.fn()}
        />
      );

      expect(screen.queryByRole("button", { name: /apply changes/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
      // The proposed list itself stays visible as a record of what was proposed.
      expect(screen.getByText('Create group → "Physics IA"')).toBeTruthy();
    });

    it("shows a follow-up message after apply/cancel without losing the original conversation", () => {
      mockHook({
        messages: [
          ...messagesWithPreview("applied"),
          { id: "3", role: "assistant", text: "Done — created 2 groups and moved 13 tabs." },
        ],
      });
      render(
        <AskTabDumpPanel
          open
          workspaceId="ws-1"
          tabs={[makeTab({ id: "1", url: "https://example.com" })]}
          indexState={noIndexing}
          onOpenChange={vi.fn()}
        />
      );

      expect(screen.getByText("Organize this workspace.")).toBeTruthy();
      expect(screen.getByText("Here's what I want to change")).toBeTruthy();
      expect(screen.getByText("Done — created 2 groups and moved 13 tabs.")).toBeTruthy();
    });
  });

  describe("undo action", () => {
    function messageWithUndo(status: UndoActionStatus): AskMessage[] {
      return [
        { id: "1", role: "user", text: "Move my Physics tabs." },
        { id: "2", role: "assistant", text: "Done — moved 8 tabs into Physics IA.", undo: { entryId: "undo-1", status } },
      ];
    }

    it("renders an Undo button for a message with an available undo action", () => {
      mockHook({ messages: messageWithUndo("available") });
      render(
        <AskTabDumpPanel open workspaceId="ws-1" tabs={[makeTab({ id: "1", url: "https://example.com" })]} indexState={noIndexing} onOpenChange={vi.fn()} />
      );
      expect(screen.getByRole("button", { name: /^undo$/i })).toBeTruthy();
    });

    it("calls undoAction with the message's undo entryId when clicked", async () => {
      const undoAction = vi.fn(async () => {});
      mockHook({ messages: messageWithUndo("available"), undoAction });
      const user = userEvent.setup();

      render(
        <AskTabDumpPanel open workspaceId="ws-1" tabs={[makeTab({ id: "1", url: "https://example.com" })]} indexState={noIndexing} onOpenChange={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: /^undo$/i }));
      expect(undoAction).toHaveBeenCalledWith("undo-1");
    });

    it("shows 'Undone' instead of a clickable button once undone", () => {
      mockHook({ messages: messageWithUndo("undone") });
      render(
        <AskTabDumpPanel open workspaceId="ws-1" tabs={[makeTab({ id: "1", url: "https://example.com" })]} indexState={noIndexing} onOpenChange={vi.fn()} />
      );
      expect(screen.getByText("Undone")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^undo$/i })).toBeNull();
    });
  });

  describe("search results", () => {
    it("renders a search results card grouped by workspace for a message that ran a search", () => {
      mockHook({
        messages: [
          { id: "1", role: "user", text: "Find my physics tabs" },
          {
            id: "2",
            role: "assistant",
            text: "I found 2 relevant tabs across 2 workspaces.",
            searchResults: [
              { tabId: "t1", title: "Schwarzschild solution", url: "https://github.com/x", domain: "github.com", workspaceId: "a", workspaceName: "Physics IA", score: 6, matchReason: "title" },
              { tabId: "t2", title: "Orbital mechanics reference", url: "https://nasa.gov/x", domain: "nasa.gov", workspaceId: "b", workspaceName: "Research", score: 4, matchReason: "semantic" },
            ],
          },
        ],
      });

      render(
        <AskTabDumpPanel open workspaceId="ws-1" tabs={[makeTab({ id: "1", url: "https://example.com" })]} indexState={noIndexing} onOpenChange={vi.fn()} />
      );

      expect(screen.getByText("I found 2 relevant tabs across 2 workspaces.")).toBeTruthy();
      expect(screen.getByText("Physics IA")).toBeTruthy();
      expect(screen.getByText("Research")).toBeTruthy();
      expect(screen.getByText("Schwarzschild solution")).toBeTruthy();
      expect(screen.getByText("Orbital mechanics reference")).toBeTruthy();
    });

    it("does not render a search results card for a message with no search results", () => {
      mockHook({ messages: [{ id: "1", role: "assistant", text: "Just an answer." }] });
      render(
        <AskTabDumpPanel open workspaceId="ws-1" tabs={[makeTab({ id: "1", url: "https://example.com" })]} indexState={noIndexing} onOpenChange={vi.fn()} />
      );
      expect(screen.queryByText(/result/i)).toBeNull();
    });
  });
});
