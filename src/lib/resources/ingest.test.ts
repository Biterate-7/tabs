import { describe, expect, it } from "vitest";
import { adoptTabsAsSources, describeIngestion, ingestResources, isContentUnavailable, needsAttention, projectSources, sourceCounts } from "./ingest";
import { EXTRACTION_ERRORS, LEGACY_BLOCKED_MESSAGE } from "./extraction";
import { readTabResource } from "./read";
import { stripWrongTypedTabFields } from "@/lib/tabs/sanitize";
import { parseSingleUrl } from "@/lib/tabs/parse";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

const NOW = 1_800_000_000_000;

function store(tabs: Tab[] = [], other: Tab[] = []): WorkspaceStore {
  return {
    version: 1,
    currentId: "a",
    workspaces: [
      { id: "a", name: "History IA", tabs, sections: [], createdAt: 1, updatedAt: 1 },
      { id: "b", name: "Physics", tabs: other, sections: [], createdAt: 1, updatedAt: 1 },
    ],
  };
}

const plain = (url: string, title?: string): Tab => ({ ...parseSingleUrl(url)!, ...(title ? { title } : {}) });

describe("ingestResources", () => {
  it("adds a PDF, a video and two pages as typed, pending sources", () => {
    const result = ingestResources(
      store(),
      "a",
      [
        { url: "https://www.jfklibrary.org/archive/cuban-missile-crisis.pdf", title: "Cuban Missile Crisis.pdf" },
        { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Crisis explained" },
        { url: "https://www.britannica.com/event/Cuban-missile-crisis", title: "Britannica" },
        { url: "https://en.wikipedia.org/wiki/Cuban_Missile_Crisis" },
      ],
      "chrome",
      NOW
    )!;
    const sources = projectSources(result.store.workspaces[0]!);
    expect(sources.map((tab) => tab.resource!.kind)).toEqual(["pdf", "youtube", "webpage", "webpage"]);
    expect(sources.every((tab) => tab.resource!.status === "pending" && tab.resource!.origin === "chrome" && tab.resource!.addedAt === NOW)).toBe(true);
    expect(sources[0]!.title).toBe("Cuban Missile Crisis.pdf");
    expect(describeIngestion(result.plan)).toEqual({ added: 4, duplicates: 0, invalid: 0 });
    // The other project is untouched.
    expect(result.store.workspaces[1]!.tabs).toEqual([]);
  });

  it("refuses a duplicate source, including another address shape of it", () => {
    const first = ingestResources(store(), "a", [{ url: "https://youtu.be/dQw4w9WgXcQ" }], "chrome", NOW)!;
    const second = ingestResources(first.store, "a", [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x" }], "extension", NOW + 1)!;
    expect(second.plan.outcomes[0]).toMatchObject({ status: "duplicate", tabId: first.plan.added[0]!.id });
    expect(second.store).toBe(first.store);
  });

  it("treats a repeat within one batch as a duplicate", () => {
    const result = ingestResources(store(), "a", [{ url: "https://x.com/a/" }, { url: "http://www.x.com/a#b" }], "chrome", NOW)!;
    expect(result.plan.outcomes.map((outcome) => outcome.status)).toEqual(["added", "duplicate"]);
  });

  it("makes an already-saved plain tab a source instead of a second copy", () => {
    const saved = plain("https://www.britannica.com/event/Cuban-missile-crisis", "Britannica");
    const result = ingestResources(store([saved]), "a", [{ url: "https://britannica.com/event/Cuban-missile-crisis/" }], "chrome", NOW)!;
    expect(result.plan.outcomes[0]).toMatchObject({ status: "adopted", tabId: saved.id });
    const tabs = result.store.workspaces[0]!.tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.resource).toMatchObject({ kind: "webpage", status: "pending" });
    expect(tabs[0]!.title).toBe("Britannica");
  });

  it("keeps the good inputs of a batch with bad ones", () => {
    const result = ingestResources(
      store(),
      "a",
      [{ url: "https://good.example/one" }, { url: "chrome://settings" }, { url: "not a url at all" }, { url: "example.org/two" }],
      "chrome",
      NOW
    )!;
    expect(result.plan.outcomes.map((outcome) => outcome.status)).toEqual(["added", "invalid", "invalid", "added"]);
    expect(result.plan.outcomes[1]).toMatchObject({ reason: "unsupported-scheme" });
    expect(result.plan.outcomes[2]).toMatchObject({ reason: "not-a-url" });
    expect(projectSources(result.store.workspaces[0]!)).toHaveLength(2);
  });

  it("never touches a project it was not given", () => {
    const shared = "https://shared.example/doc";
    const result = ingestResources(store([], [plain(shared)]), "a", [{ url: shared }], "chrome", NOW)!;
    expect(result.plan.outcomes[0]!.status).toBe("added");
    expect(result.store.workspaces[1]!.tabs[0]!.resource).toBeUndefined();
  });

  it("returns null for a project that does not exist", () => {
    expect(ingestResources(store(), "missing", [{ url: "https://x.com" }], "chrome", NOW)).toBeNull();
  });

  it("adopts existing tabs as sources (the tab-dump migration path)", () => {
    const tabs = [plain("https://a.example/1", "One"), plain("https://a.example/2.pdf", "Two")];
    const result = adoptTabsAsSources(store(tabs), "a", [tabs[1]!.id], NOW)!;
    const after = result.store.workspaces[0]!.tabs;
    expect(after[0]!.resource).toBeUndefined();
    expect(after[1]!.resource).toMatchObject({ kind: "pdf", origin: "import" });
  });

  it("counts sources by status and kind", () => {
    const result = ingestResources(store(), "a", [{ url: "https://a.example/x.pdf" }, { url: "https://a.example/y" }], "manual", NOW)!;
    const workspace = result.store.workspaces[0]!;
    workspace.tabs[0]!.resource = { ...workspace.tabs[0]!.resource!, status: "ready", content: { chars: 10, extractedAt: NOW } };
    expect(sourceCounts(workspace)).toMatchObject({ total: 2, ready: 1, working: 1, byKind: { pdf: 1, webpage: 1 } });
  });

  it("keeps Chrome's icon on the source it adds (Chrome → project, web or desktop)", () => {
    const result = ingestResources(
      store(),
      "a",
      [
        { url: "https://chatgpt.com/c/abc", title: "ChatGPT", favicon: "https://chatgpt.com/cdn/assets/favicon.svg" },
        { url: "https://drive.google.com/drive/my-drive", favicon: "not an icon" },
      ],
      "extension",
      NOW
    )!;
    const [chatgpt, drive] = result.plan.added;
    expect(chatgpt).toMatchObject({ favicon: "https://chatgpt.com/cdn/assets/favicon.svg", resource: { origin: "extension" } });
    expect(drive!.favicon).toBeUndefined();
    expect(result.plan.outcomes.map((outcome) => outcome.status)).toEqual(["added", "added"]);
  });

  it("never counts a source whose site keeps its content private as needing attention", () => {
    const result = ingestResources(store(), "a", [{ url: "https://chatgpt.com/" }, { url: "https://a.example/x.pdf" }, { url: "https://a.example/y" }], "extension", NOW)!;
    const [blocked, pdf, failed] = result.store.workspaces[0]!.tabs;
    blocked!.resource = { ...blocked!.resource!, status: "partial", error: EXTRACTION_ERRORS.blocked };
    pdf!.resource = { ...pdf!.resource!, status: "partial", error: EXTRACTION_ERRORS.pdf_needs_file };
    failed!.resource = { ...failed!.resource!, status: "failed", error: EXTRACTION_ERRORS.unreachable };
    expect(isContentUnavailable(blocked!.resource)).toBe(true);
    expect([blocked, pdf, failed].map((tab) => needsAttention(tab!.resource))).toEqual([false, true, true]);
    expect(sourceCounts(result.store.workspaces[0]!)).toMatchObject({ total: 3, partial: 2, failed: 1, attention: 2 });
  });
});

describe("readTabResource (stored data, defensively)", () => {
  const base = { kind: "pdf", origin: "chrome", status: "ready", addedAt: NOW, content: { chars: 100, extractedAt: NOW, pages: 3 } };

  it("keeps a well-formed record", () => {
    expect(readTabResource(base)).toMatchObject({ kind: "pdf", status: "ready", content: { pages: 3 } });
  });

  it("brings an interrupted run back to pending", () => {
    expect(readTabResource({ ...base, status: "processing" })!.status).toBe("pending");
  });

  it("never says ready without content", () => {
    expect(readTabResource({ ...base, content: undefined })!.status).toBe("pending");
  });

  it("drops records it cannot understand, and unknown fields", () => {
    expect(readTabResource({ ...base, kind: "hologram" })).toBeUndefined();
    expect(readTabResource({ ...base, addedAt: "yesterday" })).toBeUndefined();
    expect(readTabResource(null)).toBeUndefined();
    expect(readTabResource({ ...base, secret: "x" })).not.toHaveProperty("secret");
  });

  it("shows a source saved with the old 'refused' wording the current, non-alarming words", () => {
    const saved = { ...base, kind: "webpage", status: "partial", content: undefined, error: { code: "blocked", message: LEGACY_BLOCKED_MESSAGE, retryable: false } };
    expect(readTabResource(saved)).toMatchObject({ status: "partial", error: { code: "blocked", message: EXTRACTION_ERRORS.blocked.message } });
    expect(EXTRACTION_ERRORS.blocked.message).toMatch(/^Content unavailable/);
    // Any other stored wording is the source's own and is kept.
    const other = { ...saved, error: { code: "blocked", message: "Hubble doesn't read addresses on private networks.", retryable: false } };
    expect(readTabResource(other)!.error!.message).toBe("Hubble doesn't read addresses on private networks.");
  });

  it("is applied when a stored tab is loaded, keeping the tab", () => {
    const tab = { ...plain("https://a.example/x"), resource: { kind: "bogus" } } as unknown as Tab;
    stripWrongTypedTabFields(tab);
    expect(tab.resource).toBeUndefined();
    expect(tab.url).toBe("https://a.example/x");
    const kept = { ...plain("https://a.example/y"), resource: { ...base, status: "processing" } } as unknown as Tab;
    stripWrongTypedTabFields(kept);
    expect(kept.resource!.status).toBe("pending");
  });
});
