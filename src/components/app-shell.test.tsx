import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { AppShell } from "./app-shell";
import { dismissOnboarding } from "@/lib/onboarding";
import { Toaster } from "@/components/ui/sonner";
import { AppearanceProvider } from "@/components/appearance-provider";
import { loadWorkspaceStore, saveWorkspace, saveWorkspaceStore } from "@/lib/workspace/persistence";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

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

/** Hubble opens on Home; a project's page is one click on its row in the rail. */
async function openSubject(user: ReturnType<typeof userEvent.setup>, name = "General") {
  const rail = await screen.findByRole("navigation", { name: "Projects" });
  await user.click(await within(rail).findByRole("button", { name: `Open ${name}` }));
}

/**
 * The paste-a-list dump, reached the way a student reaches it: from Home's
 * "No projects yet", a first subject (named "General" — the default's own
 * name — so every test below still reads as it did), or the subject already
 * there; then "Paste a list of tabs" on its empty page.
 */
async function openPasteBox(user: ReturnType<typeof userEvent.setup> = userEvent.setup(), name = "General") {
  await screen.findByRole("navigation", { name: "Projects" });
  const ready = screen.queryByPlaceholderText(/Paste your tabs/);
  if (ready) return ready;
  if (!screen.queryByRole("button", { name: /Paste a list of tabs/ })) {
    const start = screen.queryByRole("region", { name: "Get started" });
    if (start) {
      await user.click(within(start).getByRole("button"));
      await user.type(await screen.findByLabelText("Project name"), name);
      await user.click(screen.getByRole("button", { name: "Create project" }));
    } else {
      await openSubject(user, name);
    }
  }
  await user.click(await screen.findByRole("button", { name: /Paste a list of tabs/ }));
  return screen.findByPlaceholderText(/Paste your tabs/);
}

/** An empty subject on screen: its one-line empty state. */
async function expectEmptySubject() {
  expect(await screen.findByText("Nothing saved yet")).toBeTruthy();
}

async function dumpOneTab(user: ReturnType<typeof userEvent.setup>, url = "https://github.com/a") {
  await user.type(await openPasteBox(user), url);
  await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
  // TabInput's submit has a deliberate "Organizing…" delay, then shows a
  // DumpConfirmation ("Dump tabs" / count / "View workspace") in place of
  // calling onDump immediately — click through it to actually land in the
  // workspace view rather than returning mid-transition.
  await user.click(await screen.findByRole("button", { name: /View workspace/ }));
  await screen.findByPlaceholderText("Search tabs...");
}

/** The shell with the appearance provider the root layout gives it — for anything that opens Settings. */
function renderShellWithAppearance() {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  return render(
    <AppearanceProvider>
      <AppShell />
    </AppearanceProvider>
  );
}

/** New subject, from the rail's "+". */
async function createSubject(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click((await screen.findAllByRole("button", { name: "New project" }))[0]!);
  await user.type(await screen.findByLabelText("Project name"), name);
  await user.click(screen.getByRole("button", { name: "Create project" }));
}

/** The subject's own ⋯ menu, on its page. */
async function openSubjectMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "More actions" }));
}

beforeEach(() => {
  window.localStorage.clear();
  // Every test in this file is about the app, not about how a first-time
  // visitor is greeted. A cleared localStorage now means "never used Hubble",
  // which AppShell answers with the public landing page rather than the app
  // shell (see the FirstRunLanding branch) — so mark onboarding as already
  // handled here, and let the tests that care about the landing page opt back
  // out by clearing it again.
  dismissOnboarding();
  // sonner's toast queue is a module-level singleton independent of any
  // particular <Toaster/> instance, so a toast fired by one test (even one
  // that never renders <Toaster/> at all) would otherwise still be sitting
  // in the queue — and immediately visible — the moment a later test does.
  toast.dismiss();
});

afterEach(() => {
  vi.unstubAllGlobals();
});


const LANDING_HEADING = "One connected workspace for everything you learn with AI.";

describe("AppShell first run", () => {
  it("greets a visitor who has never used Hubble with the public landing page", async () => {
    // Undoes the shared beforeEach: this is the one case that wants the
    // genuinely untouched state a brand-new visitor arrives in.
    window.localStorage.clear();
    render(<AppShell />);

    const heading = await screen.findByRole("heading", { level: 1, name: LANDING_HEADING });
    expect(heading).toBeTruthy();
    // The app shell itself must not be mounted underneath it — no rail, no
    // Home, nothing for a stray click to reach.
    expect(screen.queryByRole("heading", { name: "No projects yet" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Projects" })).toBeNull();
  });

  it("hands over to the app once the visitor chooses to open Hubble", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click((await screen.findAllByRole("button", { name: /Open Hubble/ }))[0]);

    // Home, with the one thing to do first.
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeTruthy();
  });

  it("sends a returning visitor straight to the app, landing page skipped", async () => {
    // Onboarding already handled (the shared beforeEach) and nothing
    // persisted: an empty workspace belongs to the app, not to marketing.
    render(<AppShell />);
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: LANDING_HEADING })).toBeNull();
  });

  it("keeps a visitor who has dumped tabs out of the landing page", async () => {
    // The gate is conservative on both halves — the onboarding flag AND an
    // entirely empty store. Someone with real tabs is never sent to marketing,
    // whatever the flag says.
    window.localStorage.clear();
    saveWorkspace([makeTab({ id: "t1" })]);
    render(<AppShell />);

    const rail = await screen.findByRole("navigation", { name: "Projects" });
    expect(within(rail).getByRole("button", { name: "Open General" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: LANDING_HEADING })).toBeNull();
  });
});
describe("AppShell persistence", () => {
  it("shows Home when nothing is persisted", async () => {
    render(<AppShell />);
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeTruthy();
  });

  it("persists a dumped workspace and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await openPasteBox(user),
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
    await openSubject(user);

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
      await openPasteBox(user),
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
    await openSubject(user);

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
      await openPasteBox(user),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    await user.click(await screen.findByRole("button", { name: /View workspace/ }));
    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);

    await openSubjectMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Clear" }));
    await user.click(await screen.findByRole("button", { name: "Clear project" }));
    await expectEmptySubject();

    unmount();
    render(<AppShell />);
    await openSubject(user);
    await expectEmptySubject();
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
      await openPasteBox(user),
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
  it("gives a brand-new user a single clean default workspace — shown as no projects yet", async () => {
    render(<AppShell />);
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeTruthy();
    expect(loadWorkspaceStore()?.workspaces.map((w) => w.name) ?? ["General"]).toEqual(["General"]);
  });

  it("makes the first project out of that default rather than beside it", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await openPasteBox(user, "History HL");
    const saved = loadWorkspaceStore()!;
    expect(saved.workspaces.map((w) => w.name)).toEqual(["History HL"]);
  });

  it("keeps a first project the student called General", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);
    await openPasteBox(user, "General");
    unmount();
    render(<AppShell />);
    // Its name and emptiness match the untouched default, but it is the student's: it stays listed.
    const rail = await screen.findByRole("navigation", { name: "Projects" });
    expect(within(rail).getByRole("button", { name: "Open General" })).toBeTruthy();
  });

  it("migrates existing legacy single-workspace data into the default workspace automatically", async () => {
    const user = userEvent.setup();
    saveWorkspace([makeTab({ id: "1", domain: "github.com", url: "https://github.com/a" })]);

    render(<AppShell />);

    expect((await screen.findAllByText("General")).length).toBeGreaterThan(0);
    await openSubject(user);
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
  });

  it("creates a new workspace and switches to it", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await createSubject(user, "Second");

    await expectEmptySubject();
    expect(await screen.findByRole("heading", { name: "Second", level: 1 })).toBeTruthy();
  });

  it("renames the current workspace", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await createSubject(user, "General");
    await openSubjectMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Rename project" }));
    const input = await screen.findByPlaceholderText("Project name");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findAllByText("Renamed")).length).toBeGreaterThan(0);
  });

  /*
    The longest test in the file: two dumps, a workspace creation, a switch,
    and two searches — around a dozen real `userEvent` interactions, each
    driving the organize pipeline and a re-render.

    It needs more than the 5s default on this machine, and it needed more
    before the Agent World was removed too: measured at 5.2s against the
    pre-removal tree and 5.1s after, so the cost is the interactions rather
    than anything the agent work changed. Given a longer budget it passes in
    ~7s. Raised rather than split, because what it is checking — that two
    workspaces genuinely hold different tabs — is one claim and reads best as
    one test.
  */
  it("keeps each workspace's tabs separate when switching between them", { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await dumpOneTab(user, "https://github.com/a");

    await createSubject(user, "Second");

    await dumpOneTab(user, "https://arxiv.org/abs/1");
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "arxiv");
    expect((await screen.findAllByText("arxiv.org")).length).toBeGreaterThan(0);

    await openSubject(user, "General");

    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
    expect(screen.queryByText("arxiv.org")).toBeNull();
  });

  it("deletes a workspace after confirmation", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await createSubject(user, "General");
    await createSubject(user, "Second");
    expect((await screen.findAllByText("Second")).length).toBeGreaterThan(0);

    await openSubjectMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Delete project" }));
    await user.click(await screen.findByRole("button", { name: "Delete project" }));

    // Back on Home, without it.
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeTruthy();
    expect((await screen.findAllByText("General")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Second")).toBeNull();
  });

  it("never deletes the last project: there is always somewhere to put things", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await dumpOneTab(user);
    await openSubjectMenu(user);
    // The menu offers Clear, never Delete, for the only subject.
    expect(await screen.findByRole("menuitem", { name: "Clear" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete project" })).toBeNull();
  });

  it("persists multiple workspaces across a remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await dumpOneTab(user);
    await createSubject(user, "Second");

    unmount();
    render(<AppShell />);

    const rail = await screen.findByRole("navigation", { name: "Projects" });
    expect(within(rail).getByRole("button", { name: "Open Second" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: "Open General" })).toBeTruthy();
  });

  it("imports a JSON workspace export and switches to it", async () => {
    const user = userEvent.setup();
    renderShellWithAppearance();

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

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click((await screen.findAllByRole("button", { name: "Projects" })).find((b) => b.closest("nav[aria-label='Settings sections']"))!);
    const file = new File([exportedJson], "export.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Import projects from a Hubble export file"), file);

    expect((await screen.findAllByText("Imported Notes")).length).toBeGreaterThan(0);
    await openSubject(user, "Imported Notes");
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
  });

  it("rejects a malformed JSON import without crashing and leaves existing workspaces untouched", async () => {
    const user = userEvent.setup();
    renderShellWithAppearance();

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click((await screen.findAllByRole("button", { name: "Projects" })).find((b) => b.closest("nav[aria-label='Settings sections']"))!);
    const file = new File(["{not json"], "export.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Import projects from a Hubble export file"), file);

    // Nothing imported, nothing lost: the only workspace is still the untouched default.
    expect(loadWorkspaceStore()?.workspaces.map((w) => w.name) ?? ["General"]).toEqual(["General"]);
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

    await expectEmptySubject();
  });

  it("undoes an extension import", async () => {
    const user = userEvent.setup();
    renderWithToaster();

    postExtensionImport([{ url: "https://github.com/a" }]);

    await user.type(await screen.findByPlaceholderText("Search tabs..."), "github");
    expect((await screen.findAllByText("github.com")).length).toBeGreaterThan(0);
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await expectEmptySubject();
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
    await expectEmptySubject();
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

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Import from history" }));
    await user.click(await screen.findByRole("button", { name: "Scan history" }));
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

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Import from history" }));
    await user.click(await screen.findByRole("button", { name: "Scan history" }));
    expect(await screen.findByText("Hubble extension not detected.")).toBeTruthy();
  });
});

describe("AppShell section/category sync", () => {
  function makeSection(over: Partial<Section> & { id: string }): Section {
    return { parentId: null, name: "Untitled", source: "ai", createdAt: 0, updatedAt: 0, ...over };
  }

  // Reproduces the reported bug directly: a workspace whose sections were
  // seeded back when only "School" tabs existed, plus tabs that were later
  // recategorized to Projects/Creative/News without ever going through the
  // async AI/fallback organizer (the only thing that used to keep sectionId
  // in sync with category) — so on disk they carry a category but no
  // resolvable sectionId. All of School/Projects/Creative/News/Other should
  // render as their own homepage folder once this is healed on load, and
  // none of the named categories should be swallowed into "Other".
  function seedDriftedStore(): void {
    const store: WorkspaceStore = {
      version: 1,
      currentId: "w1",
      workspaces: [
        {
          id: "w1",
          name: "General",
          createdAt: 0,
          updatedAt: 0,
          sections: [makeSection({ id: "school-1", name: "School" })],
          tabs: [
            makeTab({ id: "1", domain: "khan.example", url: "https://khan.example", category: "school", sectionId: "school-1" }),
            makeTab({ id: "2", domain: "github.example", url: "https://github.example", category: "projects" }),
            makeTab({ id: "3", domain: "dribbble.example", url: "https://dribbble.example", category: "creative" }),
            makeTab({ id: "4", domain: "nytimes.example", url: "https://nytimes.example", category: "news" }),
            makeTab({ id: "5", domain: "random.example", url: "https://random.example", category: "other" }),
          ],
        },
      ],
    };
    saveWorkspaceStore(store);
  }

  it("heals drifted sections on load so every present category gets its own homepage folder", async () => {
    seedDriftedStore();
    render(<AppShell />);
    await openSubject(userEvent.setup());

    expect(await screen.findByRole("button", { name: /Open School/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Open Projects/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Open Creative/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Open News/ })).toBeTruthy();
    // Other still exists (for the genuinely other-categorized tab) but no
    // longer absorbs Projects/Creative/News.
    expect(await screen.findByRole("button", { name: /Open Other, 1 tab/ })).toBeTruthy();
  });

  it("opening the healed Projects folder shows its tab, not Other's", async () => {
    seedDriftedStore();
    const user = userEvent.setup();
    render(<AppShell />);
    await openSubject(user);

    await user.click(await screen.findByRole("button", { name: /Open Projects/ }));
    expect((await screen.findAllByText("github.example")).length).toBeGreaterThan(0);
  });

  it("recategorizing a tab to a brand-new category creates and shows a matching folder immediately", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await dumpOneTab(user, "https://example.com/a");

    await user.type(await screen.findByPlaceholderText("Search tabs..."), "example.com");
    await user.click(screen.getByRole("button", { name: /Change category for example\.com/ }));
    await user.click(await screen.findByText("News"));

    await user.clear(screen.getByPlaceholderText("Search tabs..."));
    expect(await screen.findByRole("button", { name: /Open News/ })).toBeTruthy();
  });
});

describe("AppShell timestamp stamping", () => {
  // Regression: the dump's organization pass writes sectionId,
  // organizationStatus and organizationReason straight into the persisted
  // workspace. It used to do that with an inline object spread that bumped
  // only the workspace's updatedAt, so a tab the pipeline had just filed was
  // persisted still carrying its creation-time updatedAt — a real mutation
  // that a later sync would have treated as unmodified.
  it("stamps updatedAt on tabs that organization actually places", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await dumpOneTab(user, "https://github.com/torvalds/linux");

    const store = loadWorkspaceStore();
    const workspace = store?.workspaces.find((w) => w.id === store.currentId);
    const placed = (workspace?.tabs ?? []).filter((t) => t.sectionId !== undefined);
    expect(placed.length).toBeGreaterThan(0);

    for (const tab of placed) {
      expect(typeof tab.createdAt).toBe("number");
      expect(typeof tab.updatedAt).toBe("number");
      // Placement is a modification, so updatedAt must have moved past the
      // creation stamp — while createdAt stays exactly where it was.
      expect(tab.updatedAt!).toBeGreaterThan(tab.createdAt!);
    }
  });

  it("keeps the workspace and its freshly placed tabs on the same clock read", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await dumpOneTab(user, "https://github.com/torvalds/linux");

    const store = loadWorkspaceStore();
    const workspace = store?.workspaces.find((w) => w.id === store.currentId);
    const placed = (workspace?.tabs ?? []).filter((t) => t.sectionId !== undefined);

    // One createTimestamp() feeds both the workspace bump and the tabs it
    // stamped, so a placed tab never looks newer than the workspace holding it.
    for (const tab of placed) {
      expect(tab.updatedAt!).toBeLessThanOrEqual(workspace!.updatedAt);
    }
  });
});

describe("AppShell Settings navigation", () => {
  /**
   * Settings reads AppearanceProvider, which the real app mounts in the root
   * layout rather than in AppShell. The suites above deliberately mount the
   * shell bare; this one needs the provider because it navigates into
   * Settings, so it gets it the same way the route does.
   */
  function renderWithAppearance() {
    // jsdom has no matchMedia, and useAppearance reads it directly to resolve
    // the OS reduced-motion preference. `afterEach`'s unstubAllGlobals puts it
    // back, so this does not leak into the suites above.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    render(
      <AppearanceProvider>
        <AppShell />
      </AppearanceProvider>
    );
  }

  it("opens Settings on its usual section from the sidebar, and returns", async () => {
    const user = userEvent.setup();
    renderWithAppearance();

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const general = await screen.findAllByRole("button", { name: "General" });
    expect(general.some((button) => button.getAttribute("aria-current") === "true")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Back" }));
    // Back where Settings was opened from: Home.
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeTruthy();
  });

  it("offers no route into the removed agent product — Command Centre, AI chats, agent history or Agent World", async () => {
    // The world is gone from navigation, not merely hidden. A rail row that
    // still existed would be the "dead UI left behind" this removal was
    // meant to avoid.
    renderWithAppearance();
    await screen.findByRole("button", { name: "Settings" });

    expect(screen.queryByRole("button", { name: "Agent World" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agent World settings" })).toBeNull();
    // "AI" is a destination again, but a different one: using saved context in ChatGPT, Claude,
    // Gemini or Perplexity (components/ai/ai-view.tsx) — no agent, run or chat of Hubble's own.
    for (const name of [/command cent(re|er)/i, /^AI chats$/i, /^AI activity$/i, /agents?/i]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
});
