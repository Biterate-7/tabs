import { describe, it, expect, vi, afterEach } from "vitest";
import { downloadViaAnchor, webPlatform } from "./web";

/**
 * The blob-URL download these cases cover used to live in
 * src/lib/workspace/export.ts as `downloadTextFile`; it moved here so the
 * web and desktop ways of saving a file sit behind one interface. The
 * assertions are the original ones, unchanged — this is the same behaviour
 * in a new home, not new behaviour.
 */
describe("downloadViaAnchor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a blob, triggers a download, and cleans up the object URL", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:mock");
    const revokeObjectURL = vi.fn();
    window.URL.createObjectURL = createObjectURL;
    window.URL.revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    expect(downloadViaAnchor("test.txt", "hello world", "text/plain;charset=utf-8")).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");

    clickSpy.mockRestore();
  });

  it("returns false if the download sequence throws", () => {
    window.URL.createObjectURL = () => {
      throw new Error("nope");
    };
    expect(downloadViaAnchor("test.txt", "hello", "text/plain")).toBe(false);
  });

  it("removes the anchor from the document again, leaving no stray node behind", () => {
    window.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
    window.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const before = document.body.querySelectorAll("a").length;
    expect(downloadViaAnchor("test.txt", "hi", "text/plain")).toBe(true);
    expect(document.body.querySelectorAll("a").length).toBe(before);
  });
});

describe("webPlatform", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("identifies as the web platform", () => {
    expect(webPlatform.kind).toBe("web");
  });

  it("saveTextFile honours the caller's mime type", async () => {
    const created: Blob[] = [];
    window.URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:mock";
    }) as unknown as typeof window.URL.createObjectURL;
    window.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await webPlatform.saveTextFile("w.json", "{}", "application/json;charset=utf-8");

    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("application/json;charset=utf-8");
  });

  it("openExternal opens a new tab with noopener, never navigating the current one", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await webPlatform.openExternal("https://example.com/a");
    expect(openSpy).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer");
  });
});

describe("webPlatform.openExternal is a guarded navigation sink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses non-http(s) schemes", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    for (const unsafe of [
      "javascript://example.com/%0aalert(1)",
      "data://example.com/x",
      "file://example.com/share",
      "about:blank",
      "not a url",
    ]) {
      await webPlatform.openExternal(unsafe);
    }

    expect(openSpy).not.toHaveBeenCalled();
  });

  it("still opens ordinary http(s) URLs", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await webPlatform.openExternal("https://example.com/path_with_underscores");
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/path_with_underscores",
      "_blank",
      "noopener,noreferrer"
    );
  });
});
