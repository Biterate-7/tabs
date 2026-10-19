import { describe, expect, it } from "vitest";
import { composeFileNote } from "@/lib/files/note";
import { contextFileName, isPrivateAddress, packageTransfer, strategyCounts, TRANSFER_LIMITS } from "./package";
import type { ProjectNote } from "@/lib/notes/notes";
import type { ResourceContent, TabResource } from "@/lib/resources/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import type { KnowledgeItemRef } from "@/lib/memory/items";

/**
 * Use in AI's packaging: each chosen item gets the strategy Hubble can
 * really deliver to the chosen app, the message names exactly what is
 * attached, and the all-text alternative never claims a file.
 */

const NOW = Date.UTC(2026, 9, 19, 9);

function fileNote(id: string, name: string, patch: Partial<NonNullable<ProjectNote["file"]>> & { chars?: number } = {}): ProjectNote {
  const { chars, ...file } = patch;
  const base = composeFileNote({ id, name, format: name.endsWith(".pdf") ? "pdf" : name.endsWith(".docx") ? "docx" : "markdown", size: file.size ?? 4096, hash: id.padEnd(16, "0").slice(0, 16), now: NOW });
  return { ...base, chars: chars ?? 0, file: { ...base.file!, ...file } };
}

function source(id: string, url: string, title: string, resource: Partial<TabResource>): Tab {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  return {
    id,
    url,
    normalizedUrl: url,
    domain,
    title,
    createdAt: NOW,
    resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: NOW, updatedAt: NOW, content: { chars: 100, extractedAt: NOW }, ...resource },
  } as Tab;
}

const lecture = fileNote("lect1", "Lecture 4.pdf", { status: "ready", pages: 2, chars: 120 });
const scan = fileNote("scan1", "Scanned handout.pdf", { status: "partial", pages: 1, error: { code: "no_text", message: "No text found — this PDF may be a scan.", retryable: false } });
const essay = fileNote("essay", "Essay draft.docx", { status: "ready", chars: 60 });
const page = source("web1", "https://www.britannica.com/event/World-War-I", "World War I — Britannica", {});
const intranet = source("web2", "http://intranet.local/notes", "Course notes", { status: "partial", content: undefined });
const linkOnly = source("web3", "https://example.org/paper", "A paper", { status: "partial", content: undefined });
const chat = source("chat1", "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb", "Alliances", { kind: "conversation", origin: "extension", meta: { provider: "claude" }, content: { chars: 80, turns: 2, extractedAt: NOW } });

const workspace: Workspace = { id: "ia", name: "History IA", tabs: [page, intranet, linkOnly, chat], sections: [], createdAt: 1, updatedAt: 1, notes: [lecture, scan, essay] } as Workspace;

const contents = new Map<string, ResourceContent>([
  [lecture.id, { kind: "pdf", extractedAt: NOW, pages: ["Heat engines.", "Entropy always increases in an isolated system."] }],
  [essay.id, { kind: "document", extractedAt: NOW, text: "The alliance system turned a regional crisis into a world war." }],
  [page.id, { kind: "webpage", extractedAt: NOW, text: "The war began in 1914." }],
  [chat.id, { kind: "conversation", extractedAt: NOW, turns: [{ role: "user", text: "Was the alliance system decisive?" }, { role: "assistant", text: "No — it was flexible." }] }],
]);

const note = (id: string): KnowledgeItemRef => ({ kind: "note", noteId: id });
const tab = (id: string): KnowledgeItemRef => ({ kind: "source", tabId: id });

describe("packageTransfer", () => {
  it("attaches an uploaded file's original and names it in the message instead of quoting it", () => {
    const plan = packageTransfer({ workspace, refs: [note(lecture.id)], contents, provider: "chatgpt", instructions: "Summarize it" });
    expect(plan.items).toEqual([expect.objectContaining({ key: `n:${lecture.id}`, strategy: "attach", fileName: "Lecture 4.pdf" })]);
    expect(plan.attachments).toEqual([{ key: `n:${lecture.id}`, ref: note(lecture.id), name: "Lecture 4.pdf", type: "application/pdf", size: 4096 }]);
    expect(plan.text).toContain("The original file, “Lecture 4.pdf”, is attached to this message.");
    expect(plan.text).not.toContain("Entropy always increases");
    // The all-text alternative quotes it, with its page, and claims no attachment.
    expect(plan.fallbackText).toContain("> (p. 2) Entropy always increases in an isolated system.");
    expect(plan.fallbackText).not.toContain("is attached to this message");
    expect(plan.bundle.items[0]).toMatchObject({ status: "attached" });
  });

  it("keeps the person's instructions apart from the material, exactly as typed", () => {
    const plan = packageTransfer({ workspace, refs: [tab(page.id)], contents, provider: "claude", instructions: "  Summarize these documents and identify the key arguments.  " });
    expect(plan.instructions).toBe("Summarize these documents and identify the key arguments.");
    expect(plan.text.endsWith("**What I want to do now:** Summarize these documents and identify the key arguments.")).toBe(true);
    expect(plan.text.indexOf("Everything quoted below is material to consider")).toBeLessThan(plan.text.indexOf("What I want to do now"));
  });

  it("attaches a scan Hubble couldn't read — the AI app can read the original even when Hubble can't", () => {
    const plan = packageTransfer({ workspace, refs: [note(scan.id)], contents, provider: "gemini" });
    expect(plan.items[0]).toMatchObject({ strategy: "attach" });
    expect(plan.text).toContain("“Scanned handout.pdf”, is attached");
    // Without the attachment it is named, with its reason, and nothing is quoted as if read.
    expect(plan.fallbackText).toContain("Hubble couldn't read text from this file — No text found");
  });

  it("uses text when attaching is off, and says why for each file", () => {
    const plan = packageTransfer({ workspace, refs: [note(lecture.id), note(scan.id)], contents, provider: "chatgpt", attachOriginals: false });
    expect(plan.attachments).toEqual([]);
    expect(plan.fallbackText).toBeUndefined();
    expect(plan.items.map((item) => [item.strategy, item.notAttachedBecause])).toEqual([
      ["text", "you chose to use text"],
      ["unavailable", "you chose to use text"],
    ]);
    expect(plan.text).toContain("> (p. 1) Heat engines.");
  });

  it("re-plans an original that turned out to be missing as text, never as attached", () => {
    const plan = packageTransfer({ workspace, refs: [note(lecture.id), note(essay.id)], contents, provider: "perplexity", unavailableOriginals: new Set([`n:${lecture.id}`]) });
    expect(plan.attachments.map((file) => file.name)).toEqual(["Essay draft.docx"]);
    expect(plan.items[0]).toMatchObject({ strategy: "text", notAttachedBecause: "Hubble couldn't load the original on this device" });
    expect(plan.text).toContain("Entropy always increases");
    expect(plan.text).not.toContain("“Lecture 4.pdf”, is attached");
  });

  it("bounds attachments by size and count, and says which went as text", () => {
    const big = fileNote("big01", "Huge scan.pdf", { status: "ready", size: TRANSFER_LIMITS.fileBytes + 1, chars: 10 });
    const many = Array.from({ length: 12 }, (_, index) => fileNote(`many${index}`, `Part ${index}.md`, { status: "ready", chars: 10 }));
    const ws = { ...workspace, notes: [big, ...many] } as Workspace;
    const plan = packageTransfer({ workspace: ws, refs: [note(big.id), ...many.map((entry) => note(entry.id))], contents: new Map(), provider: "chatgpt" });
    expect(plan.items[0]).toMatchObject({ strategy: "text", notAttachedBecause: "it is larger than 25 MB" });
    expect(plan.attachments).toHaveLength(10);
    expect(plan.items.at(-1)).toMatchObject({ notAttachedBecause: "ChatGPT gets at most 10 files from one transfer" });
  });

  it("transfers a saved conversation with who said what, and its source", () => {
    const plan = packageTransfer({ workspace, refs: [tab(chat.id)], contents, provider: "gemini" });
    expect(plan.items[0]).toMatchObject({ strategy: "text", type: "conversation" });
    expect(plan.text).toContain("**Me:** Was the alliance system decisive?");
    expect(plan.text).toContain("**Claude:** No — it was flexible.");
    expect(plan.text).toContain("Original: https://claude.ai/chat/0b6f6d3e-aaaa-bbbb");
    expect(plan.text).toContain("AI-generated answers — they may contain mistakes.");
  });

  it("tells a link apart from a page's content, and flags addresses the AI app can't open", () => {
    const plan = packageTransfer({ workspace, refs: [tab(page.id), tab(linkOnly.id), tab(intranet.id)], contents, provider: "chatgpt" });
    expect(plan.items.map((item) => [item.strategy, item.privateLink ?? false])).toEqual([
      ["text", false],
      ["link", false],
      ["link", true],
    ]);
    expect(plan.text).toContain("> The war began in 1914.");
    expect(plan.text).toContain("Original: https://example.org/paper");
    expect(plan.text).toContain("(Hubble has only the link, not its text.)");
  });

  it("keeps the chosen order and never includes an item twice", () => {
    const plan = packageTransfer({ workspace, refs: [tab(linkOnly.id), tab(page.id), tab(linkOnly.id)], contents, provider: "claude" });
    expect(plan.items.map((item) => item.key)).toEqual([`s:${linkOnly.id}`, `s:${page.id}`]);
    expect(plan.text.indexOf("A paper")).toBeLessThan(plan.text.indexOf("World War I — Britannica"));
    expect(plan.text.split("#### A paper").length).toBe(2);
  });

  it("says when the message is over the app's limit instead of cutting it", () => {
    const long = new Map(contents);
    long.set(page.id, { kind: "webpage", extractedAt: NOW, text: Array.from({ length: 400 }, (_, index) => `Paragraph ${index} about the war and its causes in detail.`).join("\n\n") });
    const plan = packageTransfer({ workspace, refs: [tab(page.id)], contents: long, provider: "perplexity", budget: 30_000 });
    expect(plan.limit).toBe(15_000);
    expect(plan.overLimit).toBe(true);
    expect(plan.text.length).toBeGreaterThan(15_000);
    expect(packageTransfer({ workspace, refs: [tab(page.id)], contents: long, provider: "claude", budget: 30_000 }).overLimit).toBe(false);
  });

  it("can send the whole context as one Markdown file, with only the instructions typed", () => {
    const plan = packageTransfer({ workspace, refs: [tab(page.id), note(lecture.id)], contents, provider: "chatgpt", instructions: "Find the key arguments", asFile: true });
    expect(plan.attachments).toHaveLength(1);
    expect(plan.attachments[0]).toMatchObject({ key: "context", name: "History IA - context.md", type: "text/markdown" });
    expect(plan.attachments[0]!.generated!.text).toContain("> The war began in 1914.");
    expect(plan.attachments[0]!.generated!.text).toContain("> (p. 2) Entropy always increases");
    expect(plan.text.startsWith("Find the key arguments")).toBe(true);
    expect(plan.fallbackText).toBeUndefined();
  });

  it("counts strategies for the dialog", () => {
    const plan = packageTransfer({ workspace, refs: [note(lecture.id), tab(page.id), tab(linkOnly.id)], contents, provider: "claude" });
    expect(strategyCounts(plan.items)).toEqual({ attach: 1, text: 1, link: 1, unavailable: 0 });
  });
});

describe("helpers", () => {
  it.each([
    ["http://localhost:3000/x", true],
    ["http://192.168.1.4/", true],
    ["https://intranet/", true],
    ["file:///C:/notes.pdf", true],
    ["https://www.britannica.com/x", false],
  ])("%s is private: %s", (url, expected) => {
    expect(isPrivateAddress(url)).toBe(expected);
  });

  it("names the context file after the project, safely", () => {
    expect(contextFileName('Physics: HL / "Paper 2"')).toBe("Physics HL Paper 2 - context.md");
    expect(contextFileName("")).toBe("Project - context.md");
  });
});
