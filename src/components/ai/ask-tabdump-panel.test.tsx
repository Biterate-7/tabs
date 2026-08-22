import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskTabDumpPanel } from "./ask-tabdump-panel";
import * as useAskTabDumpModule from "@/hooks/use-ask-tabdump";
import type { Tab } from "@/lib/tabs/types";
import type { AskMessage } from "@/lib/ai/types";

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
}) {
  vi.mocked(useAskTabDumpModule.useAskTabDump).mockReturnValue({
    messages: overrides.messages ?? [],
    isSending: overrides.isSending ?? false,
    send: overrides.send ?? vi.fn(),
    regenerate: overrides.regenerate ?? vi.fn(),
    clear: overrides.clear ?? vi.fn(),
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
});
