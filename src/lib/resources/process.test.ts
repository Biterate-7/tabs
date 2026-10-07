import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestPdf } from "./__fixtures__/pdf";
import { boundContent, deleteContent, getContent, getProjectContents, putContent, pruneProjectContent, resetContentStoreForTests } from "./content-store";
import { attachPdfFile, attachTranscript, markProcessing, processSource, requeue, shouldProcess } from "./process";
import { ingestResources } from "./ingest";
import { setStorageNamespace } from "@/lib/storage/namespace";
import type { ProcessDeps } from "./process";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

const NOW = 1_800_000_000_000;

function sourceTab(url: string, title?: string): Tab {
  const store: WorkspaceStore = { version: 1, currentId: "p", workspaces: [{ id: "p", name: "History IA", tabs: [], sections: [], createdAt: 1, updatedAt: 1 }] };
  return ingestResources(store, "p", [{ url, ...(title ? { title } : {}) }], "chrome", NOW)!.store.workspaces[0]!.tabs[0]!;
}

function deps(extract: ProcessDeps["extract"]): ProcessDeps {
  return { extract, putContent, now: () => NOW + 5 };
}

beforeEach(() => {
  resetContentStoreForTests();
  setStorageNamespace(null);
});

describe("content store", () => {
  it("keeps content per account and project, and never lists another project's", async () => {
    await putContent("p", "t1", { kind: "webpage", text: "alpha", extractedAt: 1 });
    await putContent("q", "t2", { kind: "webpage", text: "beta", extractedAt: 1 });
    expect([...(await getProjectContents("p")).keys()]).toEqual(["t1"]);
    expect((await getContent("p", "t1"))?.text).toBe("alpha");
    expect(await getContent("p", "t2")).toBeUndefined();

    setStorageNamespace("user-2");
    expect((await getProjectContents("p")).size).toBe(0);
    setStorageNamespace(null);
  });

  it("deletes and prunes", async () => {
    await putContent("prune", "a", { kind: "webpage", text: "a", extractedAt: 1 });
    await putContent("prune", "b", { kind: "webpage", text: "b", extractedAt: 1 });
    expect(await pruneProjectContent("prune", new Set(["a"]))).toBe(1);
    await deleteContent("prune", ["a"]);
    expect((await getProjectContents("prune")).size).toBe(0);
  });

  it("bounds content and says it was cut", () => {
    const bounded = boundContent({ kind: "webpage", text: "x".repeat(500_000), extractedAt: 1 });
    expect(bounded.text).toHaveLength(400_000);
    expect(bounded.truncated).toBe(true);
  });
});

describe("processSource", () => {
  it("stores the content first, then says ready, and takes the page's title only when it had none", async () => {
    const tab = sourceTab("https://www.britannica.com/event/x");
    const result = await processSource("p", tab, deps(async () => ({ ok: true, kind: "webpage", status: "ready", finalUrl: tab.url, title: "Cuban missile crisis", meta: { siteName: "Britannica" }, content: { text: "In October 1962…" } })));
    expect(result.resource).toMatchObject({ status: "ready", meta: { siteName: "Britannica" }, content: { chars: 16 } });
    expect(result.title).toBe("Cuban missile crisis");
    expect((await getContent("p", tab.id))?.text).toBe("In October 1962…");

    const titled = sourceTab("https://a.example/y", "My own title");
    const kept = await processSource("p", titled, deps(async () => ({ ok: true, kind: "webpage", status: "ready", finalUrl: titled.url, title: "Theirs", meta: {}, content: { text: "t" } })));
    expect(kept.title).toBeUndefined();
  });

  it("records a partial reading with its reason, and no content", async () => {
    const tab = sourceTab("https://journal.example/paper.pdf");
    const result = await processSource("p", tab, deps(async () => ({ ok: true, kind: "pdf", status: "partial", finalUrl: tab.url, meta: {}, error: { code: "pdf_needs_file", message: "PDF detected. Hubble needs the file itself to read its contents.", retryable: true } })));
    expect(result.resource).toMatchObject({ status: "partial", error: { code: "pdf_needs_file" } });
    expect(result.resource.content).toBeUndefined();
    expect(await getContent("p", tab.id)).toBeUndefined();
  });

  it("fails (retryably) when the reader is unreachable, and when it throws", async () => {
    const tab = sourceTab("https://a.example/");
    expect((await processSource("p", tab, deps(async () => ({ ok: false, error: { code: "offline", message: "x", retryable: true } })))).resource).toMatchObject({ status: "failed", error: { retryable: true } });
    expect((await processSource("p", tab, deps(async () => { throw new Error("boom"); }))).resource.status).toBe("failed");
  });

  it("keeps an attached transcript when a re-read finds none", async () => {
    const tab = sourceTab("https://youtu.be/dQw4w9WgXcQ");
    const attached = await attachTranscript("p", tab, "0:00\nIntro\n1:00\nKennedy speaks", { putContent, now: () => NOW });
    if ("error" in attached) throw new Error(attached.error);
    expect(attached.resource).toMatchObject({ status: "ready", content: { transcriptLines: 2 } });
    const reread = await processSource("p", { ...tab, resource: attached.resource }, deps(async () => ({ ok: true, kind: "youtube", status: "partial", finalUrl: tab.url, meta: {}, error: { code: "transcript_unavailable", message: "m", retryable: false } })));
    expect(reread.resource.status).toBe("ready");
  });

  it("refuses an empty transcript", async () => {
    const tab = sourceTab("https://youtu.be/dQw4w9WgXcQ");
    expect(await attachTranscript("p", tab, "   ", { putContent, now: () => NOW })).toHaveProperty("error");
  });
});

describe("attachPdfFile", () => {
  it("reads an uploaded PDF in the browser, page by page", async () => {
    const tab = sourceTab("https://journal.example/paper.pdf");
    const file = new File([makeTestPdf(["First page", "Second page"], "Crisis")], "paper.pdf", { type: "application/pdf" });
    const result = await attachPdfFile("p", tab, file, { putContent, now: () => NOW });
    expect(result.resource).toMatchObject({ kind: "pdf", status: "ready", content: { pages: 2 }, meta: { fileName: "paper.pdf", pageCount: 2 } });
    expect((await getContent("p", tab.id))?.pages?.[1]).toContain("Second page");
  });

  it("says so when the file is not a readable PDF", async () => {
    const tab = sourceTab("https://journal.example/paper.pdf");
    const result = await attachPdfFile("p", tab, new File(["hello"], "paper.pdf"), { putContent, now: () => NOW });
    expect(result.resource).toMatchObject({ status: "partial", error: { code: "pdf_unreadable" } });
  });
});

describe("the processing state machine", () => {
  it("counts attempts when a run starts, and stops after three", () => {
    let resource = sourceTab("https://a.example/").resource!;
    for (let run = 0; run < 3; run++) {
      expect(shouldProcess(resource)).toBe(true);
      resource = { ...markProcessing(resource, NOW), status: "pending" };
    }
    expect(shouldProcess(resource)).toBe(false);
    expect(shouldProcess(requeue(resource, NOW))).toBe(true);
  });
});
