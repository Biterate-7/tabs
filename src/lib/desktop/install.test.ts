// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { checkForDesktopUpdate, probeDownload } from "./install";
import { releaseManifest, type DesktopBuild, type DesktopOs } from "./release";
import { GET as manifestRoute } from "@/app/api/desktop/release/route";

const SHA = "b".repeat(64);
const ORIGIN = "https://hubble.example";

function builds(windows: DesktopBuild): Record<DesktopOs, DesktopBuild> {
  return { windows, macos: { status: "coming_soon" }, linux: { status: "unsupported" } };
}
function serve(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;
}

describe("probeDownload", () => {
  it("reads a redirect as available, a 404 as unavailable, and anything else as unreachable", async () => {
    const answer = (response: Partial<Response>) => vi.fn(async () => response as Response) as unknown as typeof fetch;
    expect(await probeDownload("/x", answer({ type: "opaqueredirect", status: 0 }))).toBe("available");
    expect(await probeDownload("/x", answer({ type: "basic", status: 302 }))).toBe("available");
    expect(await probeDownload("/x", answer({ type: "basic", status: 404 }))).toBe("unavailable");
    expect(await probeDownload("/x", answer({ type: "basic", status: 500 }))).toBe("unreachable");
    expect(await probeDownload("/x", vi.fn(async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch)).toBe(
      "unreachable"
    );
  });
});

describe("checkForDesktopUpdate", () => {
  const published = (version: string) => releaseManifest(builds({ status: "published", version, sha256: SHA, bytes: 5_000_000 }));

  it("asks the deployed release manifest, without credentials", async () => {
    const fetchImpl = serve(published("0.1.0"));
    await checkForDesktopUpdate({ installed: "0.1.0", os: "windows", fetchImpl, origin: ORIGIN });
    expect(fetchImpl).toHaveBeenCalledWith(`${ORIGIN}/api/desktop/release`, expect.objectContaining({ credentials: "omit" }));
  });

  it("says current, ahead or available by version order", async () => {
    expect(await checkForDesktopUpdate({ installed: "0.1.0", os: "windows", fetchImpl: serve(published("0.1.0")), origin: ORIGIN })).toEqual({
      kind: "current",
      installed: "0.1.0",
      latest: "0.1.0",
    });
    expect(await checkForDesktopUpdate({ installed: "0.10.0", os: "windows", fetchImpl: serve(published("0.9.0")), origin: ORIGIN })).toMatchObject({
      kind: "ahead",
    });
    expect(await checkForDesktopUpdate({ installed: "0.1.0", os: "windows", fetchImpl: serve(published("0.2.0")), origin: ORIGIN })).toEqual({
      kind: "available",
      installed: "0.1.0",
      latest: "0.2.0",
      downloadUrl: `${ORIGIN}/api/download?platform=windows`,
      releaseUrl: "https://github.com/Biterate-7/tabs/releases/tag/desktop-v0.2.0",
      bytes: 5_000_000,
    });
  });

  it("has nothing to offer an OS with no published build", async () => {
    expect(await checkForDesktopUpdate({ installed: "0.1.0", os: "macos", fetchImpl: serve(published("0.2.0")), origin: ORIGIN })).toEqual({
      kind: "none",
      installed: "0.1.0",
    });
    expect(
      await checkForDesktopUpdate({ installed: "0.1.0", os: "windows", fetchImpl: serve(releaseManifest(builds({ status: "unpublished" }))), origin: ORIGIN })
    ).toMatchObject({ kind: "none" });
  });

  it("fails visibly on a network error, an error status, a malformed body or an unreadable version", async () => {
    const offline = vi.fn(async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch;
    expect(await checkForDesktopUpdate({ installed: "0.1.0", os: "windows", fetchImpl: offline, origin: ORIGIN })).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/Couldn't reach/),
    });
    expect(await checkForDesktopUpdate({ installed: "0.1.0", os: "windows", fetchImpl: serve({}, 503), origin: ORIGIN })).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/503/),
    });
    expect(await checkForDesktopUpdate({ installed: "0.1.0", os: "windows", fetchImpl: serve({ builds: "x" }), origin: ORIGIN })).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/unexpected/),
    });
    expect(await checkForDesktopUpdate({ installed: "dev", os: "windows", fetchImpl: serve(published("0.1.0")), origin: ORIGIN })).toMatchObject({
      kind: "failed",
    });
  });
});

describe("GET /api/desktop/release", () => {
  it("serves the shipped table to any origin, with no URL and no credentials involved", async () => {
    const response = manifestRoute();
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    const body = await response.json();
    expect(body).toEqual(JSON.parse(JSON.stringify(releaseManifest())));
    // What an installed app reads back is exactly what the web offers.
    const answer = await checkForDesktopUpdate({ installed: "0.0.1", os: "windows", fetchImpl: serve(body), origin: ORIGIN });
    expect(answer).toMatchObject({ kind: "available", latest: body.builds.windows.version });
  });
});
