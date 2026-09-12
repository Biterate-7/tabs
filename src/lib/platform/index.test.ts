import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openExternal, saveTextFile } from "./index";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

function setDesktop(on: boolean) {
  if (on) (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  else delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

describe("platform dispatch", () => {
  beforeEach(() => {
    invoke.mockReset();
    window.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
    window.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    setDesktop(false);
    vi.restoreAllMocks();
  });

  it("uses browser APIs on web and never touches Tauri IPC", async () => {
    setDesktop(false);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await openExternal("https://example.com");
    await saveTextFile("a.txt", "body", "text/plain");

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes to the Rust commands on desktop", async () => {
    setDesktop(true);
    invoke.mockResolvedValue(true);

    await openExternal("https://example.com/x");
    expect(invoke).toHaveBeenCalledWith("open_external", { url: "https://example.com/x" });

    await saveTextFile("w.json", "{}", "application/json");
    expect(invoke).toHaveBeenCalledWith("export_text_file", {
      suggestedName: "w.json",
      contents: "{}",
    });
  });

  it("never opens a browser window on desktop — that is what would hijack the app window", async () => {
    setDesktop(true);
    invoke.mockResolvedValue(undefined);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign: assignSpy },
      writable: true,
    });

    await openExternal("https://example.com/x");

    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("reports a cancelled desktop save as `false` rather than throwing", async () => {
    setDesktop(true);
    invoke.mockResolvedValue(false);
    expect(await saveTextFile("w.json", "{}", "application/json")).toBe(false);
  });

  it("reports a failed desktop save as `false` so the UI can show its error toast", async () => {
    setDesktop(true);
    invoke.mockRejectedValue(new Error("disk full"));
    expect(await saveTextFile("w.json", "{}", "application/json")).toBe(false);
  });
});
