import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/lib/tabs/types";

const extractContentForUrlsMock = vi.hoisted(() => vi.fn());
const embedTextsMock = vi.hoisted(() => vi.fn());

vi.mock("./extract-client", () => ({ extractContentForUrls: extractContentForUrlsMock }));
vi.mock("./embed-client", () => ({ embedTexts: embedTextsMock }));

const { indexWorkspace } = await import("./indexer");
const { getChunksForWorkspace } = await import("./db");

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    url: "https://example.com/a",
    normalizedUrl: "https://example.com/a",
    domain: "example.com",
    category: "research",
    title: "Title",
    ...overrides,
  };
}

afterEach(() => {
  extractContentForUrlsMock.mockReset();
  embedTextsMock.mockReset();
});

describe("indexWorkspace", () => {
  it("fetches content and embeds a new tab, storing its chunks", async () => {
    extractContentForUrlsMock.mockResolvedValue(
      new Map([["https://example.com/a", { url: "https://example.com/a", ok: true, description: "desc" }]])
    );
    embedTextsMock.mockResolvedValue({ ok: true, embeddings: [[0.1, 0.2]] });

    const ws = "ws-new";
    await indexWorkspace(ws, [makeTab()]);

    const stored = await getChunksForWorkspace(ws);
    expect(stored).toHaveLength(1);
    expect(stored[0].tabId).toBe("tab-1");
    expect(stored[0].embedding).toEqual([0.1, 0.2]);
    expect(extractContentForUrlsMock).toHaveBeenCalledWith(["https://example.com/a"]);
  });

  it("skips a tab whose title/url/category haven't changed since it was indexed", async () => {
    extractContentForUrlsMock.mockResolvedValue(new Map());
    embedTextsMock.mockResolvedValue({ ok: true, embeddings: [[0.1]] });

    const ws = "ws-unchanged";
    const tab = makeTab();
    await indexWorkspace(ws, [tab]);
    expect(embedTextsMock).toHaveBeenCalledTimes(1);

    await indexWorkspace(ws, [tab]);
    expect(embedTextsMock).toHaveBeenCalledTimes(1); // still 1 — second run did no work
    expect(extractContentForUrlsMock).toHaveBeenCalledTimes(1);
  });

  it("re-indexes a tab whose title changed", async () => {
    extractContentForUrlsMock.mockResolvedValue(new Map());
    embedTextsMock.mockResolvedValue({ ok: true, embeddings: [[0.1]] });

    const ws = "ws-changed";
    await indexWorkspace(ws, [makeTab({ title: "Old title" })]);
    await indexWorkspace(ws, [makeTab({ title: "New title" })]);

    expect(embedTextsMock).toHaveBeenCalledTimes(2);
    const stored = await getChunksForWorkspace(ws);
    expect(stored[0].text).toContain("New title");
  });

  it("removes stored chunks for tabs no longer present", async () => {
    extractContentForUrlsMock.mockResolvedValue(new Map());
    embedTextsMock.mockResolvedValue({ ok: true, embeddings: [[0.1]] });

    const ws = "ws-removed";
    await indexWorkspace(ws, [makeTab({ id: "tab-1" }), makeTab({ id: "tab-2", url: "https://example.com/b" })]);
    expect(await getChunksForWorkspace(ws)).toHaveLength(2);

    await indexWorkspace(ws, [makeTab({ id: "tab-1" })]);
    const stored = await getChunksForWorkspace(ws);
    expect(stored.map((r) => r.tabId)).toEqual(["tab-1"]);
  });

  it("leaves a batch unindexed when embedding fails, so it can retry later", async () => {
    extractContentForUrlsMock.mockResolvedValue(new Map());
    embedTextsMock.mockResolvedValue({ ok: false, error: "boom" });

    const ws = "ws-embed-fail";
    await indexWorkspace(ws, [makeTab()]);

    expect(await getChunksForWorkspace(ws)).toEqual([]);
  });

  it("does nothing for an empty tab list", async () => {
    await indexWorkspace("ws-empty", []);
    expect(extractContentForUrlsMock).not.toHaveBeenCalled();
    expect(embedTextsMock).not.toHaveBeenCalled();
  });
});
