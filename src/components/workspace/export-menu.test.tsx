import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ExportMenu } from "./export-menu";
import * as exportLib from "@/lib/workspace/export";
import * as jsonExportLib from "@/lib/workspace/json-export";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * Mocking `navigator.clipboard` and asserting on it through a rendered React
 * tree is unreliable in this environment (verified: `copyText` works
 * correctly when called directly — see export.test.ts's 10 passing tests —
 * but the mock silently doesn't connect once React rendering is involved,
 * for reasons that trace to a jsdom/Vitest realm quirk, not application
 * code). Since the clipboard/download mechanics already have their own
 * dedicated unit tests, these tests instead verify ExportMenu's actual
 * responsibility: wiring the right menu item to the right library call with
 * the right arguments, and showing the right toast.
 */
vi.mock("@/lib/workspace/export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace/export")>();
  return {
    ...actual,
    copyText: vi.fn(),
    downloadTextFile: vi.fn(),
  };
});

vi.mock("@/lib/workspace/json-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace/json-export")>();
  return {
    ...actual,
    downloadJsonFile: vi.fn(),
  };
});

function makeTab(over: Partial<Tab> & { id: string; url: string }): Tab {
  return {
    normalizedUrl: over.url,
    domain: "example.com",
    category: "other",
    ...over,
  };
}

const tabs: Tab[] = [
  makeTab({ id: "1", url: "https://github.com/a", category: "projects" }),
  makeTab({ id: "2", url: "https://arxiv.org/abs/1", category: "research" }),
];

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "General", tabs, createdAt: 1, updatedAt: 1, ...over };
}

describe("ExportMenu", () => {
  beforeEach(() => {
    vi.mocked(exportLib.copyText).mockReset().mockResolvedValue(true);
    vi.mocked(exportLib.downloadTextFile).mockReset().mockReturnValue(true);
    vi.mocked(jsonExportLib.downloadJsonFile).mockReset().mockReturnValue(true);
  });

  it("Copy all URLs copies every tab and shows the exact toast copy", async () => {
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Copy all URLs"));

    expect(exportLib.copyText).toHaveBeenCalledWith(
      "https://github.com/a\nhttps://arxiv.org/abs/1"
    );
    expect(toastSpy).toHaveBeenCalledWith("Copied 2 URLs");
  });

  it("Copy category URLs copies only that category's tabs", async () => {
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    // Clicking through into the submenu content hits an intermittent
    // pointer-events:none window on the parent menu while it's marked inert
    // during the submenu's open transition. Keyboard navigation (the same
    // path a real keyboard user takes) sidesteps that pointer-specific
    // timing entirely and is the more robust way to reach a submenu item.
    await user.click(await screen.findByText("Copy category URLs"));
    await user.keyboard("{ArrowRight}"); // open the submenu, focus its first item
    await screen.findByText(/^Research/);
    await user.keyboard("{Enter}"); // Research is CATEGORY_ORDER[0], already focused

    expect(exportLib.copyText).toHaveBeenCalledWith("https://arxiv.org/abs/1");
    expect(toastSpy).toHaveBeenCalledWith("Copied 1 URL");
  });

  it("disables categories with zero tabs in the submenu", async () => {
    const user = userEvent.setup();
    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Copy category URLs"));

    const schoolItem = (await screen.findByText(/^School/)).closest(
      '[role="menuitem"]'
    );
    expect(schoolItem?.getAttribute("aria-disabled")).toBe("true");
  });

  it("Export TXT calls downloadTextFile and shows the exact toast copy", async () => {
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Export TXT"));

    expect(exportLib.downloadTextFile).toHaveBeenCalledTimes(1);
    expect(exportLib.downloadTextFile).toHaveBeenCalledWith(
      "tabdump-export.txt",
      expect.any(String)
    );
    expect(toastSpy).toHaveBeenCalledWith("Workspace exported");
  });

  it("shows an error toast when copying fails", async () => {
    vi.mocked(exportLib.copyText).mockResolvedValue(false);
    const toastSpy = vi.spyOn(toast, "error");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Copy all URLs"));

    expect(toastSpy).toHaveBeenCalledWith("Couldn't copy to clipboard");
  });

  it("shows an error toast when export fails", async () => {
    vi.mocked(exportLib.downloadTextFile).mockReturnValue(false);
    const toastSpy = vi.spyOn(toast, "error");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Export TXT"));

    expect(toastSpy).toHaveBeenCalledWith("Couldn't export workspace");
  });

  it("does not show JSON export items when no workspace context is given", async () => {
    const user = userEvent.setup();
    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));

    expect(screen.queryByText("Export workspace (JSON)")).toBeNull();
  });

  it("Export workspace (JSON) downloads just the current workspace", async () => {
    vi.mocked(jsonExportLib.downloadJsonFile).mockReturnValue(true);
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();
    const workspace = makeWorkspace({ id: "a", name: "General" });

    render(<ExportMenu tabs={tabs} currentWorkspace={workspace} allWorkspaces={[workspace]} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Export workspace (JSON)"));

    expect(jsonExportLib.downloadJsonFile).toHaveBeenCalledTimes(1);
    const [filename, text] = vi.mocked(jsonExportLib.downloadJsonFile).mock.calls[0];
    expect(filename).toMatch(/^tabdump-general-\d{4}-\d{2}-\d{2}\.json$/);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.workspaces).toEqual([workspace]);
    expect(toastSpy).toHaveBeenCalledWith("Workspace exported as JSON");
  });

  it("only offers 'Export all workspaces' when there is more than one", async () => {
    const user = userEvent.setup();
    const workspace = makeWorkspace({ id: "a" });

    render(<ExportMenu tabs={tabs} currentWorkspace={workspace} allWorkspaces={[workspace]} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));

    expect(screen.queryByText("Export all workspaces (JSON)")).toBeNull();
  });

  it("Export all workspaces (JSON) downloads every workspace", async () => {
    vi.mocked(jsonExportLib.downloadJsonFile).mockReturnValue(true);
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();
    const workspaceA = makeWorkspace({ id: "a", name: "General" });
    const workspaceB = makeWorkspace({ id: "b", name: "Research" });

    render(
      <ExportMenu tabs={tabs} currentWorkspace={workspaceA} allWorkspaces={[workspaceA, workspaceB]} />
    );
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Export all workspaces (JSON)"));

    expect(jsonExportLib.downloadJsonFile).toHaveBeenCalledTimes(1);
    const [filename, text] = vi.mocked(jsonExportLib.downloadJsonFile).mock.calls[0];
    expect(filename).toMatch(/^tabdump-all-workspaces-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(text).workspaces).toEqual([workspaceA, workspaceB]);
    expect(toastSpy).toHaveBeenCalledWith("All workspaces exported as JSON");
  });

  it("shows an error toast when a JSON export fails", async () => {
    vi.mocked(jsonExportLib.downloadJsonFile).mockReturnValue(false);
    const toastSpy = vi.spyOn(toast, "error");
    const user = userEvent.setup();
    const workspace = makeWorkspace({ id: "a" });

    render(<ExportMenu tabs={tabs} currentWorkspace={workspace} allWorkspaces={[workspace]} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Export workspace (JSON)"));

    expect(toastSpy).toHaveBeenCalledWith("Couldn't export workspace");
  });
});
