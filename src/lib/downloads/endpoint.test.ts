// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMemoryDownloadCounter, type DownloadCounter } from "./counter";
import { resolveDownloadRequest } from "./endpoint";
import type { DesktopBuild, DesktopOs } from "@/lib/desktop/release";

const SHA = "c".repeat(64);
const PUBLISHED: Record<DesktopOs, DesktopBuild> = {
  windows: { status: "published", version: "0.1.0", sha256: SHA },
  macos: { status: "coming_soon" },
  linux: { status: "unsupported" },
};
const UNPUBLISHED: Record<DesktopOs, DesktopBuild> = { ...PUBLISHED, windows: { status: "unpublished" } };
const ASSET = "https://github.com/Biterate-7/tabs/releases/download/desktop-v0.1.0/Hubble_0.1.0_x64-setup.exe";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const NOON = Date.UTC(2026, 9, 1, 12);

function request(query: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(`https://hubble-hq.vercel.app/api/download${query}`, {
    method: init.method ?? "GET",
    headers: { "user-agent": CHROME, ...init.headers },
  });
}

async function run(query: string, init: Parameters<typeof request>[1] = {}, builds = PUBLISHED, counter: DownloadCounter = createMemoryDownloadCounter()) {
  const { response, result } = await resolveDownloadRequest(request(query, init), {
    counter: async () => counter,
    builds,
    now: () => NOON,
  });
  return { response, result, rows: await counter.rows() };
}

describe("a valid download", () => {
  it("counts one aggregate download and redirects to the published GitHub Release asset", async () => {
    const { response, rows } = await run("?platform=windows");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(ASSET);
    expect(rows).toEqual([{ day: "2026-10-01", platform: "windows", version: "0.1.0", downloads: 1 }]);
  });

  it("is never cached, so every click reaches the counter and follows the current release", async () => {
    const { response } = await run("?platform=windows");
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("adds to the same row for the same day, platform and version", async () => {
    const counter = createMemoryDownloadCounter();
    await run("?platform=windows", {}, PUBLISHED, counter);
    await run("?platform=windows", {}, PUBLISHED, counter);
    expect(await counter.rows()).toEqual([{ day: "2026-10-01", platform: "windows", version: "0.1.0", downloads: 2 }]);
  });

  it("stores nothing about who downloaded: the counter is only ever given day, platform and version", async () => {
    const record = vi.fn(async () => {});
    await resolveDownloadRequest(
      request("?platform=windows", { headers: { "x-forwarded-for": "203.0.113.9", cookie: "tabdump_session=abc", referer: "https://example.com/" } }),
      { counter: async () => ({ record, rows: async () => [] }), builds: PUBLISHED, now: () => NOON }
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ day: "2026-10-01", platform: "windows", version: "0.1.0" });
  });
});

describe("refused requests: no count, no redirect", () => {
  const cases: [string, string, number, string][] = [
    ["an unknown platform", "?platform=banana", 400, "unknown-platform"],
    ["a platform in the wrong case", "?platform=Windows", 400, "unknown-platform"],
    ["no platform", "", 400, "unexpected-parameter"],
    ["an empty platform", "?platform=", 400, "unknown-platform"],
    ["a destination URL", "?platform=windows&url=https://evil.example/x.exe", 400, "unexpected-parameter"],
    ["a redirect parameter", "?platform=windows&redirect=//evil.example", 400, "unexpected-parameter"],
    ["only a destination URL", "?url=https://evil.example/x.exe", 400, "unexpected-parameter"],
    ["a repeated platform", "?platform=windows&platform=linux", 400, "unexpected-parameter"],
    ["a file: URL as the platform", "?platform=file:///C:/x.exe", 400, "unknown-platform"],
    ["a path traversal as the platform", "?platform=../../evil", 400, "unknown-platform"],
    ["macOS, which is coming soon", "?platform=macos", 404, "not-available"],
    ["Linux, which is unsupported", "?platform=linux", 404, "not-available"],
  ];
  for (const [name, query, status, code] of cases) {
    it(name, async () => {
      const { response, rows } = await run(query);
      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBeNull();
      expect((await response.json()).error.code).toBe(code);
      expect(rows).toEqual([]);
    });
  }

  it("an unpublished Windows build", async () => {
    const { response, rows } = await run("?platform=windows", {}, UNPUBLISHED);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(rows).toEqual([]);
  });

  it("a malformed published version or checksum", async () => {
    for (const windows of [
      { status: "published", version: "0.1", sha256: SHA },
      { status: "published", version: "0.1.0/../../evil", sha256: SHA },
      { status: "published", version: "0.1.0", sha256: "nope" },
    ] as DesktopBuild[]) {
      const { response, rows } = await run("?platform=windows", {}, { ...PUBLISHED, windows });
      expect(response.status).toBe(404);
      expect(rows).toEqual([]);
    }
  });

  it("a method other than GET or HEAD", async () => {
    const { response, rows } = await run("?platform=windows", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(rows).toEqual([]);
  });
});

describe("requests that redirect but are not downloads by a person", () => {
  const cases: [string, Parameters<typeof request>[1]][] = [
    ["HEAD", { method: "HEAD" }],
    ["a Chrome speculative prefetch", { headers: { "sec-purpose": "prefetch" } }],
    ["a Chrome prerender", { headers: { "sec-purpose": "prefetch;prerender" } }],
    ["a legacy Purpose: prefetch", { headers: { purpose: "prefetch" } }],
    ["a Firefox prefetch", { headers: { "x-moz": "prefetch" } }],
    ["a Next.js router prefetch", { headers: { "next-router-prefetch": "1" } }],
    ["a search crawler", { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } }],
    ["a link previewer", { headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" } }],
    ["headless Chrome", { headers: { "user-agent": "Mozilla/5.0 HeadlessChrome/140.0.0.0" } }],
    ["curl", { headers: { "user-agent": "curl/8.9.1" } }],
    ["no user agent", { headers: { "user-agent": "" } }],
  ];
  for (const [name, init] of cases) {
    it(`${name}: same redirect, not counted`, async () => {
      const { response, result, rows } = await run("?platform=windows", init);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(ASSET);
      expect(result).toMatchObject({ outcome: "redirect", counted: false });
      expect(rows).toEqual([]);
    });
  }
});

describe("when counting fails", () => {
  it("still sends the visitor to the installer, and reports the failure without request details", async () => {
    const reportFailure = vi.fn();
    const { response, result } = await resolveDownloadRequest(request("?platform=windows", { headers: { "x-forwarded-for": "203.0.113.9" } }), {
      counter: async () => ({
        record: async () => {
          throw new Error('relation "tabdump_desktop_downloads" does not exist');
        },
        rows: async () => [],
      }),
      builds: PUBLISHED,
      reportFailure,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(ASSET);
    expect(result).toMatchObject({ counted: false });
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0][0]).toMatch(/could not count a windows 0\.1\.0 download/);
    expect(reportFailure.mock.calls[0][0]).not.toMatch(/203\.0\.113\.9|Mozilla/);
  });

  it("with no database configured, still redirects, uncounted", async () => {
    const { response, result } = await resolveDownloadRequest(request("?platform=windows"), {
      counter: async () => undefined,
      builds: PUBLISHED,
    });
    expect(response.status).toBe(302);
    expect(result).toMatchObject({ counted: false });
  });
});

describe("the shipped release state", () => {
  it("matches release.ts: refuses Windows until it is marked published there", async () => {
    const { DESKTOP_BUILDS, downloadUrl } = await import("@/lib/desktop/release");
    const counter = createMemoryDownloadCounter();
    const { response } = await resolveDownloadRequest(request("?platform=windows"), { counter: async () => counter });
    if (DESKTOP_BUILDS.windows.status === "published") {
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(downloadUrl("windows"));
    } else {
      expect(response.status).toBe(404);
    }
  });
});
