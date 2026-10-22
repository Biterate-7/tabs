import { describe, expect, it } from "vitest";
import { itemIdentity, siteHostOf } from "./item-icon";
import type { KnowledgeItem } from "./items";

const source = (url: string, extra: Partial<KnowledgeItem> = {}): Pick<KnowledgeItem, "type" | "url" | "domain" | "provider" | "fileName" | "ref"> => ({
  ref: { kind: "source", tabId: "t" },
  type: "webpage",
  url,
  domain: new URL(url).hostname.replace(/^www\./, ""),
  ...extra,
});

describe("itemIdentity", () => {
  it("draws a web page, a repository and a video as their own sites", () => {
    expect(itemIdentity(source("https://github.com/acme/mindspace"))).toEqual({ kind: "site", host: "github.com" });
    expect(itemIdentity(source("https://www.youtube.com/watch?v=abc", { type: "video" }))).toEqual({ kind: "site", host: "youtube.com" });
    expect(itemIdentity(source("https://youtu.be/abc", { type: "video" }))).toEqual({ kind: "site", host: "youtube.com" });
    expect(itemIdentity(source("https://m.youtube.com/watch?v=abc", { type: "video" }))).toEqual({ kind: "site", host: "youtube.com" });
  });

  it("carries Chrome's own icon for the page when it is one Hubble may keep", () => {
    expect(itemIdentity(source("https://docs.google.com/document/d/1"), "https://ssl.gstatic.com/docs/doc.png")).toEqual({ kind: "site", host: "docs.google.com", icon: "https://ssl.gstatic.com/docs/doc.png" });
    expect(itemIdentity(source("https://docs.google.com/document/d/1"), "javascript:alert(1)")).toEqual({ kind: "site", host: "docs.google.com" });
  });

  it("draws an AI conversation as its app, from its metadata or its address", () => {
    expect(itemIdentity(source("https://chatgpt.com/c/abc", { type: "conversation", provider: "chatgpt" }))).toEqual({ kind: "provider", provider: "chatgpt" });
    expect(itemIdentity(source("https://claude.ai/chat/abc", { type: "conversation" }))).toEqual({ kind: "provider", provider: "claude" });
    expect(itemIdentity(source("https://gemini.google.com/app/abc", { type: "conversation" }))).toEqual({ kind: "provider", provider: "gemini" });
    expect(itemIdentity(source("https://www.perplexity.ai/search/abc", { type: "conversation" }))).toEqual({ kind: "provider", provider: "perplexity" });
    // A pasted conversation from an app Hubble has no logo for, with an address, is that site.
    expect(itemIdentity({ ref: { kind: "note", noteId: "n" }, type: "conversation", url: "https://grok.com/chat/1" })).toEqual({ kind: "site", host: "grok.com" });
  });

  it("keeps the kind's glyph for uploads, notes and anything with no usable address", () => {
    expect(itemIdentity({ ref: { kind: "note", noteId: "n" }, type: "pdf", fileName: "Lecture.pdf" })).toEqual({ kind: "glyph" });
    expect(itemIdentity({ ref: { kind: "note", noteId: "n" }, type: "excerpt", url: "https://example.org/a", domain: "example.org" })).toEqual({ kind: "glyph" });
    expect(itemIdentity({ ref: { kind: "note", noteId: "n" }, type: "note" })).toEqual({ kind: "glyph" });
    expect(itemIdentity(source("http://localhost:3000/x"))).toEqual({ kind: "glyph" });
    expect(itemIdentity({ ref: { kind: "source", tabId: "t" }, type: "link", url: "file:///C:/notes.txt" })).toEqual({ kind: "glyph" });
  });
});

describe("siteHostOf", () => {
  it("is the host alone — never the path or query, which may carry tokens", () => {
    expect(siteHostOf("https://www.example.com/reset?token=secret")).toBe("example.com");
    expect(siteHostOf("not a url")).toBeUndefined();
  });
});
