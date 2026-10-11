import { describe, expect, it } from "vitest";
import { parseTimeParam, parseYouTubeUrl, youtubeEmbedUrl, youtubeMomentUrl, youtubeThumbnailUrl } from "./youtube";
import { resourceKey } from "./url";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeUrl", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, "watch"],
    [`https://youtube.com/watch?v=${ID}&list=PL123&index=2`, "watch"],
    [`https://m.youtube.com/watch?v=${ID}`, "watch"],
    [`http://www.youtube.com/watch?feature=share&v=${ID}`, "watch"],
    [`https://youtu.be/${ID}`, "share"],
    [`https://youtu.be/${ID}?si=AbCdEf`, "share"],
    [`https://www.youtube.com/shorts/${ID}`, "short"],
    [`https://www.youtube.com/embed/${ID}`, "embed"],
    [`https://www.youtube-nocookie.com/embed/${ID}`, "embed"],
    [`https://www.youtube.com/live/${ID}`, "live"],
    [`https://music.youtube.com/watch?v=${ID}`, "watch"],
  ])("%s is video %s (%s)", (url, shape) => {
    expect(parseYouTubeUrl(url)).toEqual({ videoId: ID, shape });
  });

  it.each([
    [`https://www.youtube.com/watch?v=${ID}&t=120`, 120],
    [`https://www.youtube.com/watch?v=${ID}&t=120s`, 120],
    [`https://youtu.be/${ID}?t=1m30s`, 90],
    [`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`, 3723],
    [`https://www.youtube.com/embed/${ID}?start=45`, 45],
    [`https://www.youtube.com/watch?v=${ID}#t=2m`, 120],
  ])("reads the saved start time of %s", (url, seconds) => {
    expect(parseYouTubeUrl(url)?.startSeconds).toBe(seconds);
  });

  it.each([
    ["not a url"],
    [""],
    ["https://vimeo.com/123456"],
    ["https://www.youtube.com/@somechannel"],
    ["https://www.youtube.com/playlist?list=PL123"],
    ["https://www.youtube.com/watch?v=tooshort"],
    [`https://www.youtube.com/watch?v=${ID}x`],
    ["https://www.youtube.com/watch?v=dQw4w9WgX<Q"],
    [`https://youtube.com.evil.example/watch?v=${ID}`],
    [`https://evilyoutube.com/watch?v=${ID}`],
    [`https://notyoutu.be/${ID}`],
    [`ftp://www.youtube.com/watch?v=${ID}`],
    [`javascript:alert(1)//www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/shorts/`],
  ])("rejects %s", (url) => {
    expect(parseYouTubeUrl(url)).toBeUndefined();
  });

  it("rejects an absurdly long input without parsing it", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&x=${"a".repeat(5000)}`)).toBeUndefined();
  });
});

describe("parseTimeParam", () => {
  it.each([
    ["0", undefined],
    ["-5", undefined],
    ["abc", undefined],
    ["1x", undefined],
    ["h", undefined],
    ["999999999", undefined],
    ["90", 90],
    ["2m", 120],
    ["1h", 3600],
  ])("%s → %s", (value, seconds) => {
    expect(parseTimeParam(value)).toBe(seconds);
  });
});

describe("building addresses", () => {
  it("opens a moment on the watch page, whatever shape was saved", () => {
    expect(youtubeMomentUrl(ID, 522)).toBe(`https://www.youtube.com/watch?v=${ID}&t=522s`);
    expect(youtubeMomentUrl(ID, 522.9)).toBe(`https://www.youtube.com/watch?v=${ID}&t=522s`);
    expect(youtubeMomentUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(youtubeMomentUrl(ID, 0)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it("never carries the saved start time into a search result's moment", () => {
    const saved = parseYouTubeUrl(`https://www.youtube.com/shorts/${ID}?t=30`)!;
    expect(saved.startSeconds).toBe(30);
    expect(youtubeMomentUrl(saved.videoId, 8 * 60 + 42)).toBe(`https://www.youtube.com/watch?v=${ID}&t=522s`);
  });

  it("embeds the privacy-enhanced player with the JS API on", () => {
    const url = new URL(youtubeEmbedUrl(ID, { start: 61.4, origin: "https://hubble-hq.vercel.app" }));
    expect(url.origin).toBe("https://www.youtube-nocookie.com");
    expect(url.pathname).toBe(`/embed/${ID}`);
    expect(url.searchParams.get("enablejsapi")).toBe("1");
    expect(url.searchParams.get("start")).toBe("61");
    expect(url.searchParams.get("origin")).toBe("https://hubble-hq.vercel.app");
  });

  it("uses YouTube's still for the thumbnail", () => {
    expect(youtubeThumbnailUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });

  it("agrees with duplicate detection: every shape and start time is one video", () => {
    const keys = new Set(
      [`https://www.youtube.com/watch?v=${ID}&t=120`, `https://youtu.be/${ID}?si=x`, `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/embed/${ID}?start=9`].map(resourceKey)
    );
    expect([...keys]).toEqual([`youtube:${ID}`]);
  });
});
