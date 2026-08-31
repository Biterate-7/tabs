import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { AppShell } from "./app-shell";
import { Toaster } from "@/components/ui/sonner";
import { saveWorkspace } from "@/lib/workspace/persistence";
import type { Tab } from "@/lib/tabs/types";

const fetchBrowserHistoryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser/history", () => ({ fetchBrowserHistory: fetchBrowserHistoryMock }));

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

function postExtensionImport(tabs: { url: string; title?: string }[]) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "tabdump-extension",
        type: "TABDUMP_IMPORT",
        payload: { tabs },
      },
      origin: window.location.origin,
      source: window,
    })
  );
}

async function dumpOneTab(user: ReturnType<typeof userEvent.setup>, url = "https://github.com/a") {
  await user.type(await screen.findByPlaceholderText(/Paste your tabs/), url);
  await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
  // TabInput's submit has a deliberate "Organizing…" delay, then shows a
  // DumpConfirmation ("Dump tabs" / count / "View workspace") in place of
  // calling onDump immediately — click through it to actually land in the
  // workspace view rather than returning mid-transition.
  await user.click(await screen.findByRole("button", { name: /View workspace/ }));
  await screen.findByPlaceholderText("Search tabs...");
}

async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Switch workspace" }));
}

beforeEach(() => {
  window.localStorage.clear();
  // sonner's toast queue is a module-level singleton independent of any
  // particular <Toaster/> instance, so a toast fired by one test (even one
  // that never renders <Toaster/> at all) would otherwise still be sitting
  // in the queue — and immediately visible — the moment a later test does.
  toast.dismiss();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell persistence", () => {
  it("shows the landing page when nothing is persisted", async () => {
    render(<AppShell />);
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("persists a dumped workspace and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    await user.click(await screen.findByRole("button", { name: /View workspace/ }));
    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);

    unmount();
    render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
  });

  it("persists a category reassignment", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    await user.click(await screen.findByRole("button", { name: /View workspace/ }));

    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    await user.click(
      screen.getByRole("button", { name: /Change category for github\.com/ })
    );
    await user.click(await screen.findByText("School"));

    unmount();
    render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect(await screen.findByText("School")).toBeTruthy();
  });

  it("Clear also removes the persisted workspace", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    await user.click(await screen.findByRole("button", { name: /View workspace/ }));
    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(await screen.findByRole("button", { name: "Clear workspace" }));
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();

    unmount();
    render(<AppShell />);
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("degrades gracefully when localStorage is unavailable", async () => {
    // Plain reassignment (and vi.spyOn) don't stick on jsdom's Storage
    // object — see the comment in persistence.test.ts. Replacing the whole
    // global is what actually simulates an unavailable localStorage.
    vi.stubGlobal("localStorage", {
      ...window.localStorage,
      setItem: () => {
        throw new Error("unavailable");
      },
    });
    const user = userEvent.setup();
    render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    await user.click(await screen.findByRole("button", { name: /View workspace/ }));
    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
  });
});

describe("AppShell workspaces", () => {
  it("gives a brand-new user a single clean default workspace", async () => {
    render(<AppShell />);
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
    expect(await screen.findByText("General")).toBeTruthy();
  });

  it("migrates existing legacy single-workspace data into the default workspace automatically", async () => {
    const user = userEvent.setup();
    saveWorkspace([makeTab({ id: "1", domain: "github.com", url: "https://github.com/a" })]);

    render(<AppShell />);

    expect(await screen.findByText("General")).toBeTruthy();
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
  });

  it("creates a new workspace and switches to it", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await openSwitcher(user);
    await user.click(await screen.findByText("New workspace"));
    await user.type(await screen.findByPlaceholderText("Workspace name"), "Second");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
    expect(await screen.findByText("Second")).toBeTruthy();
  });

  it("renames the current workspace", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await openSwitcher(user);
    await user.click(await screen.findByText(/^Rename/));
    const input = await screen.findByPlaceholderText("Workspace name");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Renamed")).toBeTruthy();
  });

  it("keeps each workspace's tabs separate when switching between them", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await dumpOneTab(user, "https://github.com/a");

    await openSwitcher(user);
    await user.click(await screen.findByText("New workspace"));
    await user.type(await screen.findByPlaceholderText("Workspace name"), "Second");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    await dumpOneTab(user, "https://arxiv.org/abs/1");
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "arxiv");
    expect((await screen.findAllByText("arxiv.org")).length).toBeGreaterThan(0);

    await openSwitcher(user);
    await user.click(await screen.findByText("General"));

    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
    expect(screen.queryByText("arxiv.org")).toBeNull();
  });

  it("deletes a workspace after confirmation", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await openSwitcher(user);
    await user.click(await screen.findByText("New workspace"));
    await user.type(await screen.findByPlaceholderText("Workspace name"), "Second");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("Second")).toBeTruthy();

    await openSwitcher(user);
    await user.click(await screen.findByText(/^Delete/));
    await user.click(await screen.findByRole("button", { name: "Delete workspace" }));

    expect(await screen.findByText("General")).toBeTruthy();
    expect(screen.queryByText("Second")).toBeNull();
  });

  it("replaces the only remaining workspace with a fresh empty default instead of leaving nothing", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await dumpOneTab(user);
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);

    await openSwitcher(user);
    await user.click(await screen.findByText(/^Delete/));
    await user.click(await screen.findByRole("button", { name: "Delete workspace" }));

    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
    expect(await screen.findByText("General")).toBeTruthy();
  });

  it("persists multiple workspaces across a remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await dumpOneTab(user);
    await openSwitcher(user);
    await user.click(await screen.findByText("New workspace"));
    await user.type(await screen.findByPlaceholderText("Workspace name"), "Second");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    unmount();
    render(<AppShell />);

    expect(await screen.findByText("Second")).toBeTruthy();
    await openSwitcher(user);
    expect(await screen.findByText("General")).toBeTruthy();
  });

  it("imports a JSON workspace export and switches to it", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    const exportedJson = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaces: [
        {
          id: "external-id",
          name: "Imported Notes",
          createdAt: 1,
          updatedAt: 1,
          tabs: [
            {
              id: "t1",
              url: "https://github.com/imported",
              normalizedUrl: "https://github.com/imported",
              domain: "github.com",
              category: "projects",
            },
          ],
        },
      ],
    });

    await openSwitcher(user);
    await user.click(await screen.findByText("Import from JSON…"));
    const file = new File([exportedJson], "export.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Import workspace JSON file"), file);

    expect(await screen.findByText("Imported Notes")).toBeTruthy();
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
  });

  it("rejects a malformed JSON import without crashing and leaves existing workspaces untouched", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await openSwitcher(user);
    await user.click(await screen.findByText("Import from JSON…"));
    const file = new File(["{not json"], "export.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Import workspace JSON file"), file);

    expect(await screen.findByText("General")).toBeTruthy();
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });
});

describe("AppShell undo", () => {
  function renderWithToaster() {
    return render(
      <>
        <Toaster />
        <AppShell />
      </>
    );
  }

  it("undoes a normal paste import", async () => {
    const user = userEvent.setup();
    renderWithToaster();

    await dumpOneTab(user);
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);

    await user.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("undoes an extension import", async () => {
    const user = userEvent.setup();
    renderWithToaster();

    postExtensionImport([{ url: "https://github.com/a" }]);

    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("undoes an extension import that merged into an already-populated workspace, restoring it exactly (duplicates included)", async () => {
    const user = userEvent.setup();
    renderWithToaster();

    await dumpOneTab(user, "https://github.com/a");
    // ".com" matches both domains, so both are visible while checking the
    // merge landed and again once undo has (or hasn't) reverted it.
    await user.type(await screen.findByPlaceholderText("Search tabs..."), ".com");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);

    postExtensionImport([{ url: "https://github.com/a" }, { url: "https://example.com/new" }]);
    expect((await screen.findAllByText("example.com")).length).toBeGreaterThan(0);

    // Two toasts are now on screen (the initial dump's and this merge's) —
    // the newest one (and its Undo) renders first.
    const undoButtons = await screen.findAllByRole("button", { name: "Undo" });
    await user.click(undoButtons[0]);

    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
    expect(screen.queryByText("example.com")).toBeNull();
  });

  it("undoes a large import", async () => {
    const user = userEvent.setup();
    renderWithToaster();

    const tabs = Array.from({ length: 120 }, (_, i) => ({ url: `https://example.com/page-${i}` }));
    postExtensionImport(tabs);

    expect(await screen.findByText("120 tabs imported")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("only the latest import can be undone: an older toast's Undo becomes a no-op once superseded", async () => {
    const user = userEvent.setup();
    renderWithToaster();

    await dumpOneTab(user, "https://github.com/a");
    const firstToast = await screen.findByText("1 tab imported");
    const firstUndoButton = within(firstToast.closest("li") ?? document.body).getByRole("button", {
      name: "Undo",
    });

    postExtensionImport([{ url: "https://example.com/second" }]);
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "example");
    expect((await screen.findAllByText("example.com")).length).toBeGreaterThan(0);

    await user.click(firstUndoButton);

    // The second import is still in effect: the older toast's Undo did
    // nothing (the search field still reads "example" from above).
    expect((await screen.findAllByText("example.com")).length).toBeGreaterThan(0);
  });
});

describe("AppShell History Dump", () => {
  afterEach(() => {
    fetchBrowserHistoryMock.mockReset();
  });

  it("dumps selected history candidates through the same ingestion pipeline as a normal import, skipping ones already saved", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <AppShell />
      </>
    );

    await dumpOneTab(user, "https://github.com/a");

    fetchBrowserHistoryMock.mockResolvedValue({
      ok: true,
      items: [
        // Already saved — must not be dumpable, and must not create a duplicate.
        { url: "https://github.com/a", title: "a", lastVisitTime: Date.now(), visitCount: 5, historyItemId: "1" },
        {
          url: "https://en.wikipedia.org/wiki/Tab",
          title: "Tab (interface) — a long, meaningful title",
          lastVisitTime: Date.now(),
          visitCount: 8,
          historyItemId: "2",
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "Open History Dump" }));
    await user.click(await screen.findByRole("button", { name: "Scan History" }));
    await user.click(await screen.findByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));

    expect(await screen.findByText("1 tab dumped")).toBeTruthy();
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "wikipedia");
    expect((await screen.findAllByText("en.wikipedia.org")).length).toBeGreaterThan(0);
  });

  it("shows the extension-not-detected message when history scanning fails", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await dumpOneTab(user, "https://github.com/a");

    fetchBrowserHistoryMock.mockResolvedValue({ ok: false, reason: "not-connected" });

    await user.click(screen.getByRole("button", { name: "Open History Dump" }));
    await user.click(await screen.findByRole("button", { name: "Scan History" }));
    expect(await screen.findByText("TabDump extension not detected.")).toBeTruthy();
  });
});
