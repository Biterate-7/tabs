import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteContent, getContent, getContents, putContent, resetContentStoreForTests } from "./content-store";
import { attachTranscript, markProcessing, processSource, requeue, shouldProcess } from "./process";
import { ingestResources } from "./ingest";
import { readTabResource } from "./read";
import { searchProject } from "./search";
import { EXTRACTION_ERRORS, LEGACY_TRANSCRIPT_MESSAGE } from "./extraction";
import { stripWrongTypedTabFields } from "@/lib/tabs/sanitize";
import { setStorageNamespace } from "@/lib/storage/namespace";
import type { ExtractionResponse } from "./extraction";
import type { ProcessDeps } from "./process";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * A YouTube video's transcript across its life in a project: added, read,
 * stored, searched, kept across reloads, read again, and removed — against
 * the real content store (fake-indexeddb) and the real processing state
 * machine, with the reader faked.
 */

const NOW = 1_800_000_000_000;
const ID = "dQw4w9WgXcQ";

function store(tabs: Tab[] = []): WorkspaceStore {
  return { version: 1, currentId: "physics", workspaces: [{ id: "physics", name: "Physics", tabs, sections: [], createdAt: 1, updatedAt: 1 }] };
}

function addVideo(url = `https://www.youtube.com/watch?v=${ID}`): Tab {
  return ingestResources(store(), "physics", [{ url }], "manual", NOW)!.store.workspaces[0]!.tabs[0]!;
}

const READY: ExtractionResponse = {
  ok: true,
  kind: "youtube",
  status: "ready",
  finalUrl: `https://www.youtube.com/watch?v=${ID}`,
  title: "Physics revision",
  meta: { siteName: "YouTube", author: "Physics Online" },
  content: {
    transcript: [
      { start: 522, end: 526, text: "Gravitational potential energy is mgh." },
      { start: 0, end: 3, text: "Welcome." },
    ],
    transcriptInfo: { source: "captions", language: "en", provider: "supadata" },
  },
};

function deps(extract: ProcessDeps["extract"]): ProcessDeps {
  return { extract, putContent, now: () => NOW + 5, language: () => "en-GB" };
}

beforeEach(() => {
  resetContentStoreForTests();
  setStorageNamespace(null);
});

describe("a YouTube video's transcript", () => {
  it("is extracted once, stored in order with its times and language, then searchable", async () => {
    const tab = addVideo();
    expect(tab.resource).toMatchObject({ kind: "youtube", status: "pending" });
    const extract = vi.fn(async () => READY);
    const result = await processSource("physics", tab, deps(extract));

    expect(extract).toHaveBeenCalledWith({ url: tab.url, kind: "youtube", language: "en-GB" });
    expect(result.resource).toMatchObject({ status: "ready", content: { transcriptLines: 2, language: "en" }, meta: { author: "Physics Online" } });
    expect(result.title).toBe("Physics revision");

    const stored = await getContent("physics", tab.id);
    expect(stored?.transcript).toEqual([
      { start: 0, end: 3, text: "Welcome." },
      { start: 522, end: 526, text: "Gravitational potential energy is mgh." },
    ]);
    expect(stored?.transcriptInfo).toEqual({ source: "captions", language: "en", provider: "supadata" });

    const hits = searchProject({ query: "potential energy", tabs: [{ ...tab, resource: result.resource }], contents: new Map([[tab.id, stored!]]) });
    expect(hits[0]).toMatchObject({ tabId: tab.id, location: { kind: "transcript", start: 522 } });
  });

  it("survives a reload: the tab's record and the stored transcript both come back, and nothing re-extracts", async () => {
    const tab = addVideo();
    const result = await processSource("physics", tab, deps(async () => READY));
    const saved = JSON.parse(JSON.stringify({ ...tab, resource: result.resource }));

    resetContentStoreForTests(); // a new page: the open connection and any memory are gone
    const reloaded = stripWrongTypedTabFields(saved);
    expect(reloaded?.resource).toMatchObject({ status: "ready", content: { transcriptLines: 2, language: "en" } });
    expect(shouldProcess(reloaded!.resource)).toBe(false);
    expect((await getContent("physics", tab.id))?.transcript).toHaveLength(2);
  });

  it("never claims ready for an empty or malformed transcript", async () => {
    const tab = addVideo();
    const empty = await processSource("physics", tab, deps(async () => ({ ...READY, content: { transcript: [{ text: "   " }, { text: "<b></b>" }] } })));
    expect(empty.resource).toMatchObject({ status: "partial", error: { code: "transcript_unavailable" } });
    expect(await getContent("physics", tab.id)).toBeUndefined();
  });

  it("cleans a transcript the reader sent, even from a deployment it did not ship with", async () => {
    const tab = addVideo();
    await processSource(
      "physics",
      tab,
      deps(async () => ({ ...READY, content: { transcript: [{ start: 9, text: "b &amp; c" }, { start: -4, text: "a" }, { start: 2, end: 1, text: "<i>x</i>" }], transcriptInfo: { source: "captions", language: "not a tag!" } } }))
    );
    const stored = await getContent("physics", tab.id);
    // A time that is not a time is dropped (the line is kept); with some lines untimed, the reader's order stands.
    expect(stored?.transcript).toEqual([{ start: 9, text: "b & c" }, { text: "a" }, { start: 2, text: "x" }]);
    expect(stored?.transcriptInfo).toEqual({ source: "captions" });
  });

  it("a failure leaves the video saved and retryable, and never touches its stored content", async () => {
    const tab = addVideo();
    const first = await processSource("physics", tab, deps(async () => READY));
    const before = await getContent("physics", tab.id);

    // Read again: the reader is down this time.
    const again = { ...tab, resource: markProcessing(requeue(first.resource, NOW + 10), NOW + 11) };
    const failed = await processSource("physics", again, deps(async () => ({ ok: false, error: EXTRACTION_ERRORS.offline })));
    expect(failed.resource).toMatchObject({ status: "failed", error: { retryable: true } });
    expect(failed.resource.content).toEqual(first.resource.content);
    expect(await getContent("physics", tab.id)).toEqual(before);

    // …or answers without captions: the transcript already held keeps the video ready.
    const partial = await processSource("physics", again, deps(async () => ({ ...READY, status: "partial", content: undefined, error: EXTRACTION_ERRORS.transcript_busy })));
    expect(partial.resource.status).toBe("ready");
    expect(await getContent("physics", tab.id)).toEqual(before);
  });

  it("a retry replaces the transcript in place — one record, no duplicate results", async () => {
    const tab = addVideo();
    await processSource("physics", tab, deps(async () => READY));
    const second = await processSource("physics", tab, deps(async () => ({ ...READY, content: { transcript: [{ start: 600, text: "Revised: gravitational potential energy." }] } })));
    const contents = await getContents("physics", [tab.id]);
    expect(contents.get(tab.id)?.transcript).toEqual([{ start: 600, text: "Revised: gravitational potential energy." }]);
    const hits = searchProject({ query: "gravitational", tabs: [{ ...tab, resource: second.resource }], contents }).filter((hit) => hit.type === "source" && hit.location.kind === "transcript");
    expect(hits).toHaveLength(1);
  });

  it("adding the same video again — any address shape, any start time — is a duplicate, not a second resource", () => {
    const first = ingestResources(store(), "physics", [{ url: `https://www.youtube.com/watch?v=${ID}` }], "manual", NOW)!;
    const again = ingestResources(first.store, "physics", [{ url: `https://youtu.be/${ID}?t=120` }, { url: `https://www.youtube.com/shorts/${ID}` }], "manual", NOW + 1)!;
    expect(again.plan.outcomes.map((outcome) => outcome.status)).toEqual(["duplicate", "duplicate"]);
    expect(again.store.workspaces[0]!.tabs).toHaveLength(1);
  });

  it("removing the video removes its transcript, so search cannot find it", async () => {
    const tab = addVideo();
    await processSource("physics", tab, deps(async () => READY));
    await deleteContent("physics", [tab.id]);
    expect((await getContents("physics", [tab.id])).size).toBe(0);
  });

  it("keeps a person's own transcript labelled as theirs", async () => {
    const tab = addVideo();
    const result = await attachTranscript("physics", tab, "0:00\nIntro\n8:42\nPotential energy", deps(async () => READY));
    if ("error" in result) throw new Error(result.error);
    expect((await getContent("physics", tab.id))?.transcriptInfo).toEqual({ source: "supplied" });
  });
});

describe("records saved before transcripts", () => {
  const legacy = {
    kind: "youtube",
    origin: "manual",
    status: "partial",
    addedAt: 1,
    updatedAt: 2,
    attempts: 1,
    meta: { siteName: "YouTube" },
    error: { code: "transcript_unavailable", message: LEGACY_TRANSCRIPT_MESSAGE, retryable: false },
  };

  it("a video that was never asked for a transcript is asked once", () => {
    const upgraded = readTabResource(legacy);
    expect(upgraded).toMatchObject({ kind: "youtube", status: "pending", attempts: 0, meta: { siteName: "YouTube" } });
    expect(upgraded?.error).toBeUndefined();
    expect(shouldProcess(upgraded)).toBe(true);
  });

  it("its next answer replaces the old words, so it is not asked again on every load", () => {
    const answered = { ...legacy, error: EXTRACTION_ERRORS.transcripts_off };
    expect(readTabResource(answered)).toMatchObject({ status: "partial", error: EXTRACTION_ERRORS.transcripts_off });
  });

  it("a video with a transcript the person added is left alone", () => {
    const withContent = { ...legacy, status: "ready", content: { chars: 10, transcriptLines: 2, extractedAt: 3 } };
    expect(readTabResource(withContent)).toMatchObject({ status: "ready", content: { transcriptLines: 2 } });
  });

  it("existing summaries without a language still read, and a bad language is dropped", () => {
    expect(readTabResource({ ...legacy, status: "ready", content: { chars: 1, extractedAt: 1 } })?.content).toEqual({ chars: 1, extractedAt: 1 });
    expect(readTabResource({ ...legacy, status: "ready", content: { chars: 1, extractedAt: 1, language: "<script>" } })?.content).toEqual({ chars: 1, extractedAt: 1 });
    expect(readTabResource({ ...legacy, status: "ready", content: { chars: 1, extractedAt: 1, language: "pt-BR" } })?.content).toEqual({ chars: 1, extractedAt: 1, language: "pt-BR" });
  });

  it("stored transcripts from before end times and languages still load", async () => {
    await putContent("physics", "old", { kind: "youtube", transcript: [{ start: 1, text: "old line" }], extractedAt: 1 });
    expect(await getContent("physics", "old")).toEqual({ kind: "youtube", transcript: [{ start: 1, text: "old line" }], extractedAt: 1 });
  });
});
