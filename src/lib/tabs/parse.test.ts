import { describe, expect, it } from "vitest";
import { splitInput, parseUrls, parseSingleUrl } from "./parse";

describe("splitInput", () => {
  it("splits on newlines", () => {
    expect(splitInput("https://a.com\nhttps://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on commas", () => {
    expect(splitInput("https://a.com, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on spaces", () => {
    expect(splitInput("https://a.com https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on tabs and mixed whitespace/commas", () => {
    expect(splitInput("https://a.com\t,\nhttps://b.com  https://c.com")).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
  });

  it("drops empty tokens and trims", () => {
    expect(splitInput("  \n\n , , https://a.com  ")).toEqual(["https://a.com"]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitInput("")).toEqual([]);
    expect(splitInput("   \n\t  ")).toEqual([]);
  });
});

describe("parseUrls", () => {
  it("parses well-formed URLs and assigns ids/domains", () => {
    const { tabs, invalidCount } = parseUrls(
      "https://github.com/foo\nhttps://arxiv.org/abs/1"
    );
    expect(invalidCount).toBe(0);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].domain).toBe("github.com");
    expect(tabs[0].url).toBe("https://github.com/foo");
    expect(new Set(tabs.map((t) => t.id)).size).toBe(2);
  });

  it("adds https:// to bare domains", () => {
    const { tabs, invalidCount } = parseUrls("github.com/foo");
    expect(invalidCount).toBe(0);
    expect(tabs[0].url).toBe("https://github.com/foo");
  });

  it("counts garbage tokens as invalid without throwing", () => {
    expect(() => parseUrls("not a url, ///, ,,,")).not.toThrow();
    const { tabs, invalidCount } = parseUrls("not a url, https://a.com");
    expect(tabs).toHaveLength(1);
    expect(invalidCount).toBeGreaterThan(0);
  });

  it("handles empty input", () => {
    const { tabs, invalidCount } = parseUrls("");
    expect(tabs).toEqual([]);
    expect(invalidCount).toBe(0);
  });

  it("handles mixed valid and invalid content", () => {
    const { tabs, invalidCount } = parseUrls(
      "https://github.com/a, garbage, https://arxiv.org/b, alsogarbage"
    );
    expect(tabs).toHaveLength(2);
    expect(invalidCount).toBe(2);
  });

  it("remains fast and correct for 250 URLs", () => {
    const input = Array.from(
      { length: 250 },
      (_, i) => `https://example.com/page-${i}`
    ).join("\n");
    const start = performance.now();
    const { tabs, invalidCount } = parseUrls(input);
    const elapsed = performance.now() - start;
    expect(tabs).toHaveLength(250);
    expect(invalidCount).toBe(0);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("parseSingleUrl", () => {
  it("parses a well-formed URL into a Tab", () => {
    const tab = parseSingleUrl("https://github.com/foo/bar");
    expect(tab).not.toBeNull();
    expect(tab?.domain).toBe("github.com");
    expect(tab?.url).toBe("https://github.com/foo/bar");
  });

  it("adds https:// to a bare domain", () => {
    expect(parseSingleUrl("example.com")?.url).toBe("https://example.com");
  });

  it("returns null for a garbage token instead of throwing", () => {
    expect(() => parseSingleUrl("not a url")).not.toThrow();
    expect(parseSingleUrl("not a url")).toBeNull();
    expect(parseSingleUrl("///")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseSingleUrl("  https://example.com  ")?.url).toBe("https://example.com");
  });

  it("is what parseUrls uses under the hood (same ids/domains for the same input)", () => {
    const viaSingle = parseSingleUrl("https://github.com/a");
    const viaBatch = parseUrls("https://github.com/a").tabs[0];
    expect(viaSingle?.domain).toBe(viaBatch.domain);
    expect(viaSingle?.normalizedUrl).toBe(viaBatch.normalizedUrl);
  });
});

/**
 * Underscores are legal in URL paths, query strings and fragments (RFC 3986
 * "unreserved"), and they are common in real links — MDN docs, Wikipedia
 * titles, most CMS slugs. Nothing here was broken: these cases exist because
 * a desktop QA run *appeared* to show `.../Pointer_events` being stored as
 * `.../Pointer`, and the truncation turned out to come from synthetic typing
 * emitting the Shift+Minus as a space. A space genuinely does split the
 * token (see the last case), so the two failure modes look identical from
 * the outside. These lock the real behaviour down so the next person to see
 * that symptom can rule the parser out in one test run.
 */
describe("URL punctuation is preserved", () => {
  it("keeps an underscore in the path", () => {
    const url = "https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events";
    const { tabs, invalidCount } = parseUrls(url);
    expect(invalidCount).toBe(0);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBe(url);
    expect(tabs[0].normalizedUrl).toBe(url);
  });

  it("keeps underscores in several path segments", () => {
    const url = "https://example.com/foo_bar/baz_qux";
    expect(parseUrls(url).tabs[0].url).toBe(url);
    expect(parseSingleUrl(url)?.url).toBe(url);
  });

  it("keeps underscores in query parameters", () => {
    const url = "https://example.com/search?search_term=hello_world";
    const tab = parseUrls(url).tabs[0];
    expect(tab.url).toBe(url);
    expect(tab.normalizedUrl).toContain("search_term=hello_world");
  });

  it("keeps an underscore in the fragment", () => {
    const url = "https://example.com/docs#section_name";
    // `url` is what gets displayed and opened, so it must be byte-exact.
    expect(parseUrls(url).tabs[0].url).toBe(url);
    // `normalizedUrl` intentionally drops the fragment — it is the dedupe
    // key, not the link (see normalizeUrl).
    expect(parseUrls(url).tabs[0].normalizedUrl).toBe("https://example.com/docs");
  });

  it("keeps a leading underscore in a path segment", () => {
    const url = "https://example.com/_next/static/chunk_1.js";
    expect(parseUrls(url).tabs[0].url).toBe(url);
  });

  it("keeps the other unreserved/sub-delimiter characters a real URL carries", () => {
    const url = "https://example.com/a_b-c.d~e/p+q@r?x_y=1&z=%20a!b$c'd(e)f*g;h=i#frag_1";
    const tab = parseSingleUrl(url);
    expect(tab).not.toBeNull();
    expect(tab?.url).toBe(url);
  });

  it("does not truncate, merge or reorder when underscore and plain URLs are mixed", () => {
    const input = [
      "https://github.com/torvalds/linux",
      "https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events",
      "https://arxiv.org/abs/1706.03762",
      "https://example.com/foo_bar/baz_qux",
    ].join("\n");

    const { tabs, invalidCount } = parseUrls(input);
    expect(invalidCount).toBe(0);
    expect(tabs.map((t) => t.url)).toEqual(input.split("\n"));
  });

  it("still splits on a space, which is what a mistyped underscore looks like", () => {
    // The diagnostic counterpart to the first case: identical symptom, and
    // the reason a space must keep splitting is that space-separated input
    // is a supported way to paste tabs.
    const { tabs, invalidCount } = parseUrls(
      "https://developer.mozilla.org/en-US/docs/Web/API/Pointer events"
    );
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBe("https://developer.mozilla.org/en-US/docs/Web/API/Pointer");
    expect(invalidCount).toBe(1);
  });
});

/**
 * Accepting underscores must not mean accepting anything that merely looks
 * URL-ish, and it must not open a door for a scheme that executes. These pin
 * the behaviour that already holds.
 */
describe("URL safety is not widened", () => {
  it("rejects plain words, underscored or not", () => {
    expect(parseSingleUrl("hello_world")).toBeNull();
    expect(parseSingleUrl("some_variable_name")).toBeNull();
    expect(parseUrls("hello_world not_a_url").invalidCount).toBe(2);
    expect(parseUrls("hello_world not_a_url").tabs).toEqual([]);
  });

  it("rejects scheme-only dangerous payloads", () => {
    for (const payload of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///C:/Windows/System32/drivers/etc/hosts",
      "vbscript:msgbox(1)",
    ]) {
      expect(parseSingleUrl(payload)).toBeNull();
    }
  });
});

/**
 * A `Tab` in Hubble is a saved web page the user expects to re-open, and
 * every opening path — web (openTab), desktop (Rust open_external) and the
 * extension (browser-commands.js) — already refuses anything that isn't
 * http(s). A non-http(s) Tab is therefore one that can never be opened
 * anywhere, so accepting it only means storing an un-openable row and, in
 * the `javascript:` case, carrying a payload around in local storage.
 *
 * `javascript://example.com/%0aalert(1)` is the case that matters: it is a
 * structurally valid URL with a dotted hostname, so a "does it parse and
 * have a dot" check waves it through.
 */
describe("parseSingleUrl only accepts web-openable schemes", () => {
  const UNSAFE = [
    "javascript:alert(1)",
    "javascript://example.com/%0aalert(1)",
    "JavaScript://example.com/%0aalert(1)",
    "data:text/html,<h1>x</h1>",
    "data://example.com/x",
    "file:///etc/passwd",
    "file://example.com/share",
    "vbscript:msgbox(1)",
    "vbscript://example.com/x",
    "about:blank",
    "blob:https://example.com/9b7a-1",
    "chrome://settings",
    "chrome-extension://abcdefghijklmnop/page.html",
    "ftp://example.com/file.txt",
  ];

  it.each(UNSAFE)("rejects %s", (url) => {
    expect(parseSingleUrl(url)).toBeNull();
  });

  it("counts them as invalid in a batch rather than storing them", () => {
    const { tabs, invalidCount } = parseUrls(
      ["javascript://example.com/%0aalert(1)", "https://example.com/ok_path", "file://example.com/share"].join("\n")
    );
    expect(tabs.map((t) => t.url)).toEqual(["https://example.com/ok_path"]);
    expect(invalidCount).toBe(2);
  });

  it("still accepts http and https, including odd-but-legal shapes", () => {
    for (const url of [
      "https://example.com",
      "http://example.com",
      "https://example.com/",
      "https://example.com:8443/path",
      "https://example.com/path_with_underscores",
      "https://example.com/search?q=hello_world",
      "https://example.com/#section_name",
    ]) {
      expect(parseSingleUrl(url), url).not.toBeNull();
    }
  });

  it("normalises a shouty scheme rather than rejecting it", () => {
    // `new URL` lowercases the protocol, so casing is not a bypass either way.
    expect(parseSingleUrl("HTTPS://example.com")?.url).toBe("HTTPS://example.com");
    expect(parseSingleUrl("HTTP://example.com")?.url).toBe("HTTP://example.com");
  });

  it("keeps prefixing https:// to bare domains", () => {
    expect(parseSingleUrl("example.com/foo_bar")?.url).toBe("https://example.com/foo_bar");
  });
});
