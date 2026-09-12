import { describe, expect, it, vi, afterEach } from "vitest";
import { urlsText, buildExportText, copyText } from "./export";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string; url: string }): Tab {
  return {
    normalizedUrl: over.url,
    domain: "example.com",
    category: "other",
    ...over,
  };
}

describe("urlsText", () => {
  it("joins tab urls with newlines", () => {
    const tabs = [
      makeTab({ id: "1", url: "https://a.com" }),
      makeTab({ id: "2", url: "https://b.com" }),
    ];
    expect(urlsText(tabs)).toBe("https://a.com\nhttps://b.com");
  });

  it("returns an empty string for no tabs", () => {
    expect(urlsText([])).toBe("");
  });
});

describe("buildExportText", () => {
  it("matches the spec format exactly", () => {
    const tabs = [
      makeTab({ id: "1", url: "https://arxiv.org/abs/1", category: "research" }),
      makeTab({ id: "2", url: "https://scholar.google.com/x", category: "research" }),
      makeTab({ id: "3", url: "https://classroom.google.com/c/1", category: "school" }),
    ];
    expect(buildExportText(tabs)).toBe(
      "TABDUMP EXPORT\n\nRESEARCH\n\nhttps://arxiv.org/abs/1\n\nhttps://scholar.google.com/x\n\nSCHOOL\n\nhttps://classroom.google.com/c/1\n"
    );
  });

  it("skips categories with no tabs", () => {
    const text = buildExportText([
      makeTab({ id: "1", url: "https://a.com", category: "projects" }),
    ]);
    expect(text).not.toContain("RESEARCH");
    expect(text).toContain("PROJECTS");
  });

  it("handles an empty workspace", () => {
    expect(buildExportText([])).toBe("TABDUMP EXPORT\n");
  });
});

describe("copyText", () => {
  afterEach(() => {
    Object.assign(navigator, { clipboard: undefined });
  });

  it("returns true and calls clipboard.writeText on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("returns false when clipboard is unavailable", async () => {
    Object.assign(navigator, { clipboard: undefined });
    expect(await copyText("hello")).toBe(false);
  });

  it("returns false when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(false);
  });
});
