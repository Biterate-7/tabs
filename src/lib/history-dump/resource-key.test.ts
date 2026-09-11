import { describe, expect, it } from "vitest";
import { canonicalResourceKey, searchQueryOf } from "./resource-key";

/** Two URLs are the same resource iff they produce the same key. */
function sameResource(a: string, b: string): boolean {
  return canonicalResourceKey(a) === canonicalResourceKey(b);
}

describe("canonicalResourceKey — harmless URL differences", () => {
  it("treats an exact duplicate as one resource", () => {
    expect(sameResource("https://example.com/article", "https://example.com/article")).toBe(true);
  });

  it("ignores a protocol difference", () => {
    expect(sameResource("https://example.com/article", "http://example.com/article")).toBe(true);
  });

  it("ignores a trailing slash", () => {
    expect(sameResource("https://example.com/article", "https://example.com/article/")).toBe(true);
  });

  it("ignores a www. prefix", () => {
    expect(sameResource("https://example.com/article", "https://www.example.com/article")).toBe(true);
  });

  it("ignores a mobile host prefix", () => {
    expect(sameResource("https://example.com/article", "https://m.example.com/article")).toBe(true);
  });

  it("ignores host casing", () => {
    expect(sameResource("https://EXAMPLE.com/article", "https://example.com/article")).toBe(true);
  });

  it("ignores a fragment, which addresses a section of a page rather than another page", () => {
    expect(sameResource("https://example.com/article#intro", "https://example.com/article#conclusion")).toBe(true);
    expect(sameResource("https://example.com/article#intro", "https://example.com/article")).toBe(true);
  });

  it("ignores an index file and an /amp variant", () => {
    expect(sameResource("https://example.com/guide/", "https://example.com/guide/index.html")).toBe(true);
    expect(sameResource("https://example.com/guide", "https://example.com/guide/amp")).toBe(true);
  });

  it("ignores percent-encoding differences in the path", () => {
    expect(sameResource("https://example.com/a%20b", "https://example.com/a b")).toBe(true);
  });

  it("ignores query parameter order", () => {
    expect(sameResource("https://example.com/a?x=1&y=2", "https://example.com/a?y=2&x=1")).toBe(true);
  });
});

describe("canonicalResourceKey — tracking parameters", () => {
  it("collapses differing utm campaigns onto the bare URL", () => {
    expect(sameResource("https://example.com/article?utm_source=x", "https://example.com/article?utm_source=y")).toBe(true);
    expect(sameResource("https://example.com/article?utm_source=x", "https://example.com/article")).toBe(true);
  });

  it("collapses unenumerated utm_* parameters too", () => {
    expect(sameResource("https://example.com/article?utm_id=42", "https://example.com/article")).toBe(true);
  });

  it("collapses click ids and referral markers", () => {
    for (const param of ["fbclid=a", "gclid=a", "ref=newsletter", "si=abc", "igshid=z"]) {
      expect(sameResource(`https://example.com/article?${param}`, "https://example.com/article")).toBe(true);
    }
  });
});

describe("canonicalResourceKey — parameters that identify a resource", () => {
  it("keeps different YouTube videos apart", () => {
    expect(sameResource("https://youtube.com/watch?v=AAA", "https://youtube.com/watch?v=BBB")).toBe(false);
  });

  it("keeps ?id=, ?page=, ?p= and ?q= distinct, since they address different resources", () => {
    expect(sameResource("https://example.com/doc?id=1", "https://example.com/doc?id=2")).toBe(false);
    expect(sameResource("https://example.com/list?page=1", "https://example.com/list?page=2")).toBe(false);
    expect(sameResource("https://example.com/?p=1", "https://example.com/?p=2")).toBe(false);
    expect(sameResource("https://example.com/search?q=cats", "https://example.com/search?q=dogs")).toBe(false);
  });

  it("keeps an unknown parameter rather than guessing it is noise", () => {
    expect(sameResource("https://example.com/a?variant=blue", "https://example.com/a?variant=red")).toBe(false);
    expect(sameResource("https://example.com/a?variant=blue", "https://example.com/a")).toBe(false);
  });
});

describe("canonicalResourceKey — YouTube", () => {
  it("treats share and timestamp parameters on one video as the same video", () => {
    expect(sameResource("https://youtube.com/watch?v=AAA", "https://youtube.com/watch?v=AAA&feature=share")).toBe(true);
    expect(sameResource("https://youtube.com/watch?v=AAA&t=30", "https://youtube.com/watch?v=AAA&t=120")).toBe(true);
  });

  it("treats youtu.be, /shorts, /embed and www./m. forms as the same video", () => {
    const canonical = "https://www.youtube.com/watch?v=AAA";
    for (const variant of [
      "https://youtu.be/AAA",
      "https://youtube.com/shorts/AAA",
      "https://www.youtube-nocookie.com/embed/AAA",
      "https://m.youtube.com/watch?v=AAA",
    ]) {
      expect(sameResource(canonical, variant)).toBe(true);
    }
  });

  it("keeps a playlist distinct from a video", () => {
    expect(sameResource("https://youtube.com/playlist?list=PL1", "https://youtube.com/watch?v=AAA")).toBe(false);
    expect(sameResource("https://youtube.com/playlist?list=PL1", "https://youtube.com/playlist?list=PL2")).toBe(false);
  });
});

describe("canonicalResourceKey — different pages stay different", () => {
  it("keeps different paths on one domain apart", () => {
    expect(sameResource("https://react.dev/reference/react/useMemo", "https://react.dev/reference/react/useEffect")).toBe(false);
  });

  it("keeps the same path on different domains apart", () => {
    expect(sameResource("https://a.example/article", "https://b.example/article")).toBe(false);
  });

  it("keeps product subdomains apart, since they are different sites", () => {
    expect(sameResource("https://docs.example.com/x", "https://blog.example.com/x")).toBe(false);
  });

  it("returns a stable key for an unparseable URL instead of throwing", () => {
    expect(canonicalResourceKey("not a url")).toBe("not a url");
    expect(sameResource("not a url", "NOT A URL")).toBe(true);
  });
});

describe("searchQueryOf", () => {
  it("reads the query from search endpoints", () => {
    expect(searchQueryOf(new URL("https://example.com/search?q=price+mechanism"))).toBe("price mechanism");
    expect(searchQueryOf(new URL("https://youtube.com/results?search_query=lecture"))).toBe("lecture");
    expect(searchQueryOf(new URL("https://duckduckgo.com/?q=notes"))).toBe("notes");
    expect(searchQueryOf(new URL("https://example.com/s?k=shoes"))).toBe("shoes");
  });

  it("does not mistake an ordinary page carrying a stray parameter for a search", () => {
    expect(searchQueryOf(new URL("https://example.com/articles/economics?q=highlight"))).toBeNull();
    expect(searchQueryOf(new URL("https://example.com/search"))).toBeNull();
    expect(searchQueryOf(new URL("https://example.com/search?q="))).toBeNull();
  });
});
