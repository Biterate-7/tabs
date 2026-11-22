// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/downloads/counter-server", () => ({ getDownloadCounter: vi.fn(async () => undefined) }));
// The release source asks GitHub's live releases API; the route is tested against each answer it can give,
// never against whatever GitHub lists today (that is what broke when desktop-v0.2.0 was published).
const source = vi.hoisted(() => ({ getLatestDesktopRelease: vi.fn() }));
vi.mock("@/lib/desktop/release-source", () => source);

import { releaseFromBuilds } from "@/lib/desktop/artifacts";
import { DESKTOP_BUILDS, downloadUrl } from "@/lib/desktop/release";
import type { DesktopBuild, DesktopOs } from "@/lib/desktop/release";
import { GET, HEAD } from "./route";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const req = (query: string, method = "GET") =>
  new Request(`https://hubble-hq.vercel.app/api/download${query}`, { method, headers: { "user-agent": CHROME } });

/** A newer release than the reviewed table, as GitHub would list it. */
const NEWER: Readonly<Record<DesktopOs, DesktopBuild>> = {
  ...DESKTOP_BUILDS,
  windows: { status: "published", version: "9.8.7", sha256: "a".repeat(64), bytes: 31_000_000 },
};

beforeEach(() => {
  source.getLatestDesktopRelease.mockReset();
});

describe("/api/download", () => {
  it("follows the latest published release GitHub lists, for GET and HEAD alike", async () => {
    source.getLatestDesktopRelease.mockResolvedValue({ ...releaseFromBuilds(NEWER)!, source: "github" });
    for (const handler of [GET, HEAD]) {
      const response = await handler(req("?platform=windows", handler === GET ? "GET" : "HEAD"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(downloadUrl("windows", NEWER));
      expect(response.headers.get("location")).toContain("/desktop-v9.8.7/");
    }
  });

  it("serves the reviewed release table when GitHub can't be reached: Windows redirects only once release.ts marks it published", async () => {
    // What getLatestDesktopRelease answers when GitHub fails or lists no desktop release.
    source.getLatestDesktopRelease.mockResolvedValue(releaseFromBuilds());
    for (const handler of [GET, HEAD]) {
      const response = await handler(req("?platform=windows", handler === GET ? "GET" : "HEAD"));
      if (DESKTOP_BUILDS.windows.status === "published") {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(downloadUrl("windows"));
      } else {
        expect(response.status).toBe(404);
        expect(response.headers.get("location")).toBeNull();
      }
    }
  });

  it("offers nothing when there is no release at all", async () => {
    source.getLatestDesktopRelease.mockResolvedValue(null);
    const response = await GET(req("?platform=windows"));
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses an unknown platform and any destination parameter", async () => {
    source.getLatestDesktopRelease.mockResolvedValue(releaseFromBuilds());
    expect((await GET(req("?platform=banana"))).status).toBe(400);
    const open = await GET(req("?platform=windows&url=https://evil.example"));
    expect(open.status).toBe(400);
    expect(open.headers.get("location")).toBeNull();
  });
});
