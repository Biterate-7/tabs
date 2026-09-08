/**
 * End-to-end coverage for the Graph View readiness gate: the graph must not
 * be reachable while a dump is still being organized, laid out or settled —
 * and specifically not while the pipeline is still working through the
 * leftover "Other" tabs, which is the slow tail that used to finish after the
 * user was already looking at the graph.
 *
 * The organization pipeline is mocked with a hand-controlled promise rather
 * than left to run: the whole point is to hold the app in the intermediate
 * state and assert on it, which a real (fast, unobservable) run cannot do.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { AppShell } from "./app-shell";
import { emptyReport } from "@/lib/sections/ai/report";
import { saveWorkspaceStore } from "@/lib/workspace/persistence";
import type { Section } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

type PendingRun = {
  tabs: Tab[];
  sections: Section[];
  /** Reports a pipeline stage, exactly as the real pipeline does as it enters one. */
  stage: (stage: "classifying" | "grouping" | "other") => void;
  finish: () => void;
  fail: (error: Error) => void;
};

const pipeline = vi.hoisted(() => ({ organizeTabsCollectively: vi.fn() }));
vi.mock("@/lib/sections/ai/pipeline", () => pipeline);

let pending: PendingRun[] = [];

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://example.com/${over.id}`,
    normalizedUrl: `https://example.com/${over.id}`,
    domain: "example.com",
    category: "other",
    ...over,
  };
}

function seedStore(tabCount: number): WorkspaceStore {
  const tabs = Array.from({ length: tabCount }, (_, i) => makeTab({ id: `seed${i}` }));
  const store: WorkspaceStore = {
    version: 1,
    currentId: "w1",
    workspaces: [{ id: "w1", name: "General", tabs, createdAt: 0, updatedAt: 0 }],
  };
  saveWorkspaceStore(store);
  return store;
}

/** Drives the extension-import entry point, which is one of the dump paths readiness gates. */
function postExtensionImport(urls: string[]) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "tabdump-extension",
        type: "TABDUMP_IMPORT",
        payload: { tabs: urls.map((url) => ({ url })) },
      },
      origin: window.location.origin,
      source: window,
    })
  );
}

function graphButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Open Graph View" }) as HTMLButtonElement;
}

beforeEach(() => {
  window.localStorage.clear();
  toast.dismiss();
  pending = [];
  pipeline.organizeTabsCollectively.mockImplementation(
    (_workspaceId: string, _name: string, tabs: Tab[], sections: Section[], onStage?: (s: string) => void) =>
      new Promise((resolve, reject) => {
        pending.push({
          tabs,
          sections,
          stage: (stage) => onStage?.(stage),
          finish: () => resolve({ tabs, sections, report: emptyReport(tabs.length) }),
          fail: (error) => reject(error),
        });
      })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Graph View readiness gate", () => {
  it("leaves the graph accessible when no dump is running", async () => {
    const user = userEvent.setup();
    seedStore(3);
    render(<AppShell />);

    await screen.findByPlaceholderText("Search tabs...");
    expect(graphButton().disabled).toBe(false);

    await user.click(graphButton());
    expect(await screen.findByRole("button", { name: "Back to workspace" })).toBeTruthy();
  });

  it("locks the graph for the whole dump — through the \"Other\" stage — and unlocks it only once the layout has settled", async () => {
    seedStore(3);
    render(<AppShell />);
    await screen.findByPlaceholderText("Search tabs...");

    postExtensionImport(["https://a.example.com", "https://b.example.com", "https://c.example.com"]);

    // Organizing: locked.
    await waitFor(() => expect(graphButton().disabled).toBe(true));
    expect(pending).toHaveLength(1);

    // Still locked while the pipeline works through the leftover "Other"
    // tabs — the specific window this whole gate exists for.
    pending[0].stage("other");
    expect(await screen.findByText('Organizing "Other" tabs…')).toBeTruthy();
    expect(graphButton().disabled).toBe(true);

    // Data organization done — still locked, because layout and physics are
    // part of readiness too.
    pending[0].finish();
    await waitFor(() => expect(screen.getByText(/Arranging tabs…|Finalizing layout…/)).toBeTruthy());
    expect(graphButton().disabled).toBe(true);

    // Only now, after the settle completes.
    await waitFor(() => expect(graphButton().disabled).toBe(false), { timeout: 10000 });
  }, 15000);

  it("refuses to enter the graph while organizing, even if the disabled control is bypassed", async () => {
    const user = userEvent.setup();
    seedStore(3);
    render(<AppShell />);
    await screen.findByPlaceholderText("Search tabs...");

    postExtensionImport(["https://a.example.com"]);
    await waitFor(() => expect(graphButton().disabled).toBe(true));

    // A disabled button is a hint; the gate is in the view transition itself.
    // Fire the click the palette/keyboard path would produce.
    graphButton().removeAttribute("disabled");
    await user.click(graphButton());

    expect(screen.queryByRole("button", { name: "Back to workspace" })).toBeNull();
    expect(screen.getByPlaceholderText("Search tabs...")).toBeTruthy();
  });

  it("never lets a superseded dump's completion unlock the graph", async () => {
    seedStore(3);
    render(<AppShell />);
    await screen.findByPlaceholderText("Search tabs...");

    postExtensionImport(["https://a.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(1));
    postExtensionImport(["https://b.example.com", "https://c.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(2));

    // The first, superseded dump finishes late. It must not unlock anything.
    pending[0].finish();
    await Promise.resolve();
    await waitFor(() => expect(graphButton().disabled).toBe(true));
    // Give the (stale) settle every chance to run and wrongly complete.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graphButton().disabled).toBe(true);

    // The live dump is what unlocks it.
    pending[1].finish();
    await waitFor(() => expect(graphButton().disabled).toBe(false), { timeout: 10000 });
  }, 15000);

  it("surfaces an error instead of quietly exposing a half-organized graph", async () => {
    const user = userEvent.setup();
    seedStore(3);
    render(<AppShell />);
    await screen.findByPlaceholderText("Search tabs...");

    postExtensionImport(["https://a.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(1));

    vi.spyOn(console, "error").mockImplementation(() => {});
    pending[0].fail(new Error("organize exploded"));

    expect(await screen.findByText("Couldn't finish organizing your tabs.")).toBeTruthy();

    // The error screen is reachable, and it is not the graph.
    await user.click(graphButton());
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to workspace" })).toBeNull();

    // Retrying re-runs the same organization rather than requiring a re-dump.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(pending).toHaveLength(2));
  });
});
