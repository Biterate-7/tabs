import { afterEach, describe, expect, it, vi } from "vitest";
import { categorizeTabs } from "./index";
import type { Tab } from "@/lib/tabs/types";

function makeTab(url: string, normalizedUrl: string): Tab {
  return {
    id: url,
    url,
    normalizedUrl,
    domain: new URL(normalizedUrl).hostname,
  };
}

describe("categorizeTabs", () => {
  it("assigns category and confidence to every tab without mutating originals", () => {
    const input = [
      makeTab("https://github.com/a", "https://github.com/a"),
      makeTab("https://unknown-xyz.com/", "https://unknown-xyz.com/"),
    ];
    const result = categorizeTabs(input);

    expect(result).toHaveLength(2);
    expect(result[0].category).toBe("projects");
    expect(typeof result[0].confidence).toBe("number");
    expect(result[1].category).toBe("other");

    expect(input[0].category).toBeUndefined();
  });

  it("preserves all other tab fields", () => {
    const input = [
      {
        ...makeTab("https://github.com/a", "https://github.com/a"),
        isDuplicate: true,
      },
    ];
    const result = categorizeTabs(input);
    expect(result[0].isDuplicate).toBe(true);
    expect(result[0].id).toBe(input[0].id);
  });

  it("never touches the network — categorization is fully local/deterministic, no Gemini call involved", () => {
    const fetchSpy = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;

    try {
      categorizeTabs([
        makeTab("https://github.com/a", "https://github.com/a"),
        makeTab("https://totally-unknown-domain-xyz.com/", "https://totally-unknown-domain-xyz.com/"),
      ]);
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
