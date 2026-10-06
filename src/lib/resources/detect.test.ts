import { describe, expect, it } from "vitest";
import { detectResourceType, youtubeVideoId } from "./detect";
import { resourceKey, sameResource } from "./url";

describe("detectResourceType", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "youtube"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "youtube"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "youtube"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "youtube"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "youtube"],
    ["https://example.com/papers/cuban-missile-crisis.pdf", "pdf"],
    ["https://example.com/papers/REPORT.PDF?download=1", "pdf"],
    ["https://arxiv.org/pdf/2401.01234", "pdf"],
    ["https://vimeo.com/123456", "video"],
    ["https://cdn.example.com/clip.mp4", "video"],
    ["https://example.com/notes.md", "document"],
    ["https://www.britannica.com/event/Cuban-missile-crisis", "webpage"],
    ["https://en.wikipedia.org/wiki/Cuban_Missile_Crisis", "webpage"],
    ["chrome://extensions", "unknown"],
    ["not a url", "unknown"],
  ])("%s → %s", (url, kind) => {
    expect(detectResourceType({ url })).toBe(kind);
  });

  it("trusts a MIME type over the address", () => {
    expect(detectResourceType({ url: "https://example.com/download?id=7", mimeType: "application/pdf" })).toBe("pdf");
    expect(detectResourceType({ url: "https://example.com/paper.pdf", mimeType: "text/html; charset=utf-8" })).toBe("webpage");
    expect(detectResourceType({ url: "https://example.com/x", mimeType: "video/mp4" })).toBe("video");
    expect(detectResourceType({ url: "https://example.com/x", mimeType: "text/plain" })).toBe("document");
  });

  it("keeps a YouTube page a video even when served as HTML", () => {
    expect(detectResourceType({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", mimeType: "text/html" })).toBe("youtube");
  });

  it("rejects a YouTube path that is not a video", () => {
    expect(youtubeVideoId("https://www.youtube.com/@channel")).toBeUndefined();
    expect(youtubeVideoId("https://www.youtube.com/watch?v=short")).toBeUndefined();
    expect(detectResourceType({ url: "https://www.youtube.com/@channel" })).toBe("webpage");
  });
});

describe("resourceKey", () => {
  it("folds scheme, www, case, fragment and trailing slash", () => {
    expect(resourceKey("http://WWW.Example.com/a/b/#top")).toBe(resourceKey("https://example.com/a/b"));
  });

  it("drops tracking parameters but keeps meaningful ones, in any order", () => {
    expect(sameResource("https://x.com/p?id=7&utm_source=news&fbclid=1", "https://x.com/p?id=7")).toBe(true);
    expect(sameResource("https://x.com/p?b=2&a=1", "https://x.com/p?a=1&b=2")).toBe(true);
    expect(sameResource("https://x.com/p?id=7", "https://x.com/p?id=8")).toBe(false);
  });

  it("treats every YouTube address of one video as one source", () => {
    const keys = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=share",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=120&feature=share",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    ].map(resourceKey);
    expect(new Set(keys).size).toBe(1);
    expect(resourceKey("https://youtu.be/aaaaaaaaaaa")).not.toBe(keys[0]);
  });

  it("decodes only characters that never needed encoding", () => {
    expect(sameResource("https://x.com/%7Euser/a%2Db", "https://x.com/~user/a-b")).toBe(true);
    expect(sameResource("https://x.com/a%2Fb", "https://x.com/a/b")).toBe(false);
  });

  it("keeps path case and non-default ports", () => {
    expect(sameResource("https://x.com/Paper", "https://x.com/paper")).toBe(false);
    expect(sameResource("https://x.com:8443/a", "https://x.com/a")).toBe(false);
  });

  it("refuses non-web and malformed input", () => {
    expect(resourceKey("file:///C:/a.pdf")).toBeUndefined();
    expect(resourceKey("::nope")).toBeUndefined();
    expect(sameResource("::nope", "::nope")).toBe(false);
  });
});
