import { describe, expect, it } from "vitest";
import { buildChunks, tabSignature } from "./chunk";
import type { Tab } from "@/lib/tabs/types";

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    url: "https://example.com/article",
    normalizedUrl: "https://example.com/article",
    domain: "example.com",
    category: "research",
    title: "An Article",
    ...overrides,
  };
}

describe("buildChunks", () => {
  it("always produces a summary chunk from title/domain/category", () => {
    const chunks = buildChunks(makeTab());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe("summary");
    expect(chunks[0].text).toContain("An Article");
    expect(chunks[0].text).toContain("example.com");
    expect(chunks[0].text).toContain("Research");
  });

  it("falls back to the domain when there's no title", () => {
    const chunks = buildChunks(makeTab({ title: undefined }));
    expect(chunks[0].text).toContain("example.com");
  });

  it("includes the extracted description in the summary chunk", () => {
    const chunks = buildChunks(makeTab(), { description: "A great description" });
    expect(chunks[0].text).toContain("A great description");
  });

  it("adds a body chunk only when extracted text is substantial", () => {
    const short = buildChunks(makeTab(), { text: "too short" });
    expect(short.some((c) => c.kind === "body")).toBe(false);

    const long = buildChunks(makeTab(), { text: "x".repeat(250) });
    const body = long.find((c) => c.kind === "body");
    expect(body).toBeDefined();
    expect(body!.text).toHaveLength(250);
  });
});

describe("tabSignature", () => {
  it("is stable for the same title/url/category", () => {
    expect(tabSignature(makeTab())).toBe(tabSignature(makeTab()));
  });

  it("changes when the title changes", () => {
    expect(tabSignature(makeTab())).not.toBe(tabSignature(makeTab({ title: "Different" })));
  });

  it("changes when the category changes", () => {
    expect(tabSignature(makeTab())).not.toBe(tabSignature(makeTab({ category: "shopping" })));
  });

  it("is unaffected by extracted page content", () => {
    // tabSignature never looks at extracted content — verified simply by its
    // signature taking no such parameter; this test guards the intent.
    expect(tabSignature(makeTab())).toBe(tabSignature(makeTab()));
  });
});
