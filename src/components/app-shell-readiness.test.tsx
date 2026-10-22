/**
 * End-to-end coverage for the dump organization lifecycle as the shell runs
 * it: the workspace says which stage a dump is in — including the slow
 * leftover "Other" tail — and stops saying so exactly when the pipeline
 * finishes, never because a stale run finished; a failure says so and can be
 * retried without dumping again. None of it gates the Graph, which draws
 * saved tabs as they arrive (the separate tab map it once guarded is gone).
 *
 * The organization pipeline is mocked with a hand-controlled promise rather
 * than left to run: the whole point is to hold the app in the intermediate
 * state and assert on it, which a real (fast, unobservable) run cannot do.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { AppShell } from "./app-shell";
import { dismissOnboarding } from "@/lib/onboarding";
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

/** Hubble opens on Home: open the subject, where the organizer reports. */
async function openSubject() {
  const user = userEvent.setup();
  const rail = await screen.findByRole("navigation", { name: "Projects" });
  await user.click(within(rail).getByRole("button", { name: "Open General" }));
  await screen.findByPlaceholderText("Search tabs...");
}

function organizerStatus(): HTMLElement | null {
  return screen.queryAllByRole("status").find((element) => /Organizing|Receiving|Building groups|Couldn't finish/.test(element.textContent ?? "")) ?? null;
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

describe("dump organization lifecycle", () => {
  it("reports each stage of a dump — through the \"Other\" tail — and clears once the pipeline finishes", async () => {
    seedStore(3);
    render(<AppShell />);
    await openSubject();
    expect(organizerStatus()).toBeNull();

    postExtensionImport(["https://a.example.com", "https://b.example.com", "https://c.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(1));
    await waitFor(() => expect(organizerStatus()).not.toBeNull());

    pending[0].stage("other");
    expect(await screen.findByText('Organizing "Other" tabs…')).toBeTruthy();

    // Finished means finished: there is no layout half left to wait for.
    pending[0].finish();
    await waitFor(() => expect(organizerStatus()).toBeNull());
  });

  it("keeps the Graph open to the person while a dump organizes", async () => {
    const user = userEvent.setup();
    seedStore(3);
    render(<AppShell />);
    await openSubject();

    postExtensionImport(["https://a.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(await screen.findByRole("application", { name: /Knowledge graph/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tab map" })).toBeNull();
  });

  it("never lets a superseded dump's completion end the current one", async () => {
    seedStore(3);
    render(<AppShell />);
    await openSubject();

    postExtensionImport(["https://a.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(1));
    postExtensionImport(["https://b.example.com", "https://c.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(2));

    // The first, superseded dump finishes late. The second is still running.
    pending[0].finish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(organizerStatus()).not.toBeNull();

    pending[1].finish();
    await waitFor(() => expect(organizerStatus()).toBeNull());
  });

  it("surfaces a failure and retries the same organization without a re-dump", async () => {
    const user = userEvent.setup();
    seedStore(3);
    render(<AppShell />);
    await openSubject();

    postExtensionImport(["https://a.example.com"]);
    await waitFor(() => expect(pending).toHaveLength(1));

    vi.spyOn(console, "error").mockImplementation(() => {});
    pending[0].fail(new Error("organize exploded"));

    expect(await screen.findByText("Couldn't finish organizing your tabs.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(pending).toHaveLength(2));
  });
});
