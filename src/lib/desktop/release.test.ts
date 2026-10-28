// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_BUILDS,
  RELEASE_REPOSITORY,
  RELEASES_PAGE_URL,
  anyDesktopBuildPublished,
  compareVersions,
  formatInstallerSize,
  parseReleaseManifest,
  releaseManifest,
  releasePageUrl,
  desktopLinkLabel,
  desktopOffer,
  detectVisitorOs,
  downloadHref,
  downloadUrl,
  parseDesktopOs,
  isOfficialReleaseUrl,
  statusLabel,
  windowsInstallerName,
  type DesktopBuild,
  type DesktopOs,
} from "./release";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const tauri = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as {
  productName: string;
  version: string;
  bundle: { targets: string[] };
};

const SHA = "a".repeat(64);
const PUBLISHED: Record<DesktopOs, DesktopBuild> = {
  windows: { status: "published", version: "0.1.0", sha256: SHA },
  macos: { status: "coming_soon" },
  linux: { status: "unsupported" },
};
/** Every OS unpublished — the state before a release, and the next version's state between draft and publish. */
const UNPUBLISHED: Record<DesktopOs, DesktopBuild> = { ...PUBLISHED, windows: { status: "unpublished" } };

/** The Windows release published on GitHub as desktop-v0.1.0, checked byte-for-byte after download. */
const RELEASED_SHA256 = "660326fd1312727ba4edef5cc17a2755ae437e31674ac12d4359ac67174dc9d3";

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

describe("the shipped release state", () => {
  it("publishes exactly the verified Windows 0.1.0 release, and nothing for macOS or Linux", () => {
    // Size as GitHub lists the asset (gh api …/releases/tags/desktop-v0.1.0).
    expect(DESKTOP_BUILDS.windows).toEqual({ status: "published", version: "0.1.0", sha256: RELEASED_SHA256, bytes: 30_260_142 });
    expect(downloadUrl("windows")).toBe(
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/desktop-v0.1.0/Hubble_0.1.0_x64-setup.exe`
    );
    expect(downloadHref("windows")).toBe("/api/download?platform=windows");
    expect(downloadUrl("macos")).toBeNull();
    expect(downloadUrl("linux")).toBeNull();
    expect(anyDesktopBuildPublished()).toBe(true);
    expect(desktopLinkLabel()).toBe("Download Hubble");
  });

  it("before anything is published, links to no installer", () => {
    for (const os of ["windows", "macos", "linux"] as const) expect(downloadUrl(os, UNPUBLISHED)).toBeNull();
    expect(anyDesktopBuildPublished(UNPUBLISHED)).toBe(false);
    expect(desktopLinkLabel(UNPUBLISHED)).toBe("Hubble Desktop");
  });

  it("claims only what the Tauri bundle config can build", () => {
    // tauri.conf.json bundles Windows formats only; macOS and Linux must not
    // be listed as anything that exists.
    expect(tauri.bundle.targets.every((target) => target === "msi" || target === "nsis")).toBe(true);
    expect(DESKTOP_BUILDS.macos.status).toBe("coming_soon");
    expect(DESKTOP_BUILDS.linux.status).toBe("unsupported");
  });

  it("never publishes a build newer than the app's version, and keeps the product name", () => {
    expect(tauri.productName).toBe("Hubble");
    const windows = DESKTOP_BUILDS.windows;
    if (windows.status === "published") {
      // Equal once a release is published and turned on here; the app is one
      // version ahead between the version bump and that pull request
      // (docs/desktop-release.md), never behind.
      expect(compareVersions(windows.version, tauri.version)).toBeLessThanOrEqual(0);
      expect(downloadUrl("windows")).not.toBeNull();
    }
  });
});

describe("downloadUrl", () => {
  it("names only this repository's GitHub Release asset, built from the version", () => {
    expect(downloadUrl("windows", PUBLISHED)).toBe(
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/desktop-v0.1.0/Hubble_0.1.0_x64-setup.exe`
    );
    expect(windowsInstallerName("0.1.0")).toBe(`${tauri.productName}_0.1.0_x64-setup.exe`);
  });

  it("refuses a malformed version or checksum rather than linking to a guess", () => {
    for (const windows of [
      { status: "published", version: "0.1.0/../../evil", sha256: SHA },
      { status: "published", version: "latest", sha256: SHA },
      { status: "published", version: "0.1.0", sha256: "not-a-hash" },
    ] as DesktopBuild[]) {
      expect(downloadUrl("windows", { ...PUBLISHED, windows })).toBeNull();
    }
  });

  it("has no installer for an OS the release workflow does not build, even if marked published", () => {
    expect(downloadUrl("macos", { ...PUBLISHED, macos: { status: "published", version: "0.1.0", sha256: SHA } })).toBeNull();
  });
});

describe("downloadHref and parseDesktopOs", () => {
  it("links to the measured endpoint only for a published build", () => {
    expect(downloadHref("windows", PUBLISHED)).toBe("/api/download?platform=windows");
    expect(downloadHref("windows")).toBe(DESKTOP_BUILDS.windows.status === "published" ? "/api/download?platform=windows" : null);
    expect(downloadHref("macos", PUBLISHED)).toBeNull();
  });

  it("accepts only an exact known platform", () => {
    expect(parseDesktopOs("windows")).toBe("windows");
    for (const bad of ["Windows", " windows", "win", "banana", "", null, undefined, "__proto__", "toString"]) {
      expect(parseDesktopOs(bad), String(bad)).toBeNull();
    }
  });
});

describe("isOfficialReleaseUrl", () => {
  it("accepts only the exact release-asset shape on github.com", () => {
    const ok = `https://github.com/${RELEASE_REPOSITORY}/releases/download/desktop-v1.2.3/Hubble_1.2.3_x64-setup.exe`;
    expect(isOfficialReleaseUrl(ok)).toBe(true);
    for (const bad of [
      ok.replace("https:", "http:"),
      ok.replace("github.com", "github.com.evil.example"),
      ok.replace("Biterate-7/tabs", "someone/else"),
      `${ok}?x=1`,
      `${ok}#x`,
      `https://hubble-hq.vercel.app/Hubble_1.2.3_x64-setup.exe`,
      `https://tabs-git-preview.vercel.app/download/Hubble.exe`,
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/desktop-v1.2.3/other.exe`,
      "file:///C:/Users/me/Hubble.exe",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isOfficialReleaseUrl(bad), bad).toBe(false);
    }
  });
});

describe("detectVisitorOs", () => {
  it("reads the user agent", () => {
    expect(detectVisitorOs({ userAgent: UA.windows })).toBe("windows");
    expect(detectVisitorOs({ userAgent: UA.mac })).toBe("macos");
    expect(detectVisitorOs({ userAgent: UA.linux })).toBe("linux");
    expect(detectVisitorOs({ userAgent: UA.android })).toBe("mobile");
    expect(detectVisitorOs({ userAgent: UA.iphone })).toBe("mobile");
    expect(detectVisitorOs({ userAgent: UA.chromeos })).toBe("unknown");
    expect(detectVisitorOs({ userAgent: "" })).toBe("unknown");
    expect(detectVisitorOs({})).toBe("unknown");
  });

  it("prefers the client-hint platform, and treats a touch-screen Mac as an iPad", () => {
    expect(detectVisitorOs({ userAgent: UA.linux, platform: "Windows" })).toBe("windows");
    expect(detectVisitorOs({ platform: "macOS" })).toBe("macos");
    expect(detectVisitorOs({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe("mobile");
  });
});

describe("desktopOffer", () => {
  it("offers the real installer to a Windows visitor once it is published", () => {
    const offer = desktopOffer("windows", PUBLISHED);
    expect(offer).toMatchObject({ kind: "download", label: "Download Hubble for Windows", version: "0.1.0" });
    // The page links to the measured endpoint; the endpoint holds the GitHub URL.
    expect(offer.kind === "download" && offer.href).toBe("/api/download?platform=windows");
  });

  it("says plainly that Windows is not yet available while it is unpublished", () => {
    expect(desktopOffer("windows", UNPUBLISHED)).toEqual({
      kind: "unavailable",
      os: "windows",
      label: "Hubble for Windows",
      reason: "The Windows build is not publicly available yet.",
    });
  });

  it("never offers a macOS or Linux download", () => {
    for (const builds of [DESKTOP_BUILDS, PUBLISHED]) {
      expect(desktopOffer("macos", builds)).toMatchObject({ kind: "unavailable", reason: "Hubble for macOS is coming soon." });
      expect(desktopOffer("linux", builds)).toMatchObject({ kind: "unavailable", reason: "Hubble Desktop is not available for Linux." });
    }
    expect(statusLabel("macos")).toBe("Coming soon");
    expect(statusLabel("linux")).toBe("Not available");
  });

  it("asks an unknown platform to choose, and tells a phone to use a computer", () => {
    expect(desktopOffer("unknown", UNPUBLISHED)).toMatchObject({
      kind: "choose",
      label: "Download Hubble Desktop",
      reason: "Hubble Desktop is not publicly available yet.",
    });
    expect(desktopOffer("unknown", PUBLISHED)).toMatchObject({ reason: "Choose your platform below." });
    expect(desktopOffer("mobile")).toMatchObject({ kind: "choose", reason: expect.stringMatching(/runs on a computer/) });
  });

  it("labels links to the page by whether anything can be downloaded", () => {
    expect(desktopLinkLabel(PUBLISHED)).toBe("Download Hubble");
    expect(statusLabel("windows", PUBLISHED)).toBe("Version 0.1.0");
    expect(statusLabel("windows", UNPUBLISHED)).toBe("Not yet available");
    expect(statusLabel("windows")).toBe("Version 0.1.0");
  });
});

describe("release pages and versions", () => {
  it("links one version's release page, and the list for anything that isn't a version", () => {
    expect(RELEASES_PAGE_URL).toBe(`https://github.com/${RELEASE_REPOSITORY}/releases`);
    expect(releasePageUrl("0.1.0")).toBe(`https://github.com/${RELEASE_REPOSITORY}/releases/tag/desktop-v0.1.0`);
    for (const bad of ["latest", "0.1", "0.1.0/../../x", ""]) expect(releasePageUrl(bad), bad).toBe(RELEASES_PAGE_URL);
  });

  it("orders versions numerically, not as text", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBeNull();
    expect(compareVersions("1.0", "1.0.0")).toBeNull();
  });

  it("formats an installer's size, and nothing for no size", () => {
    expect(formatInstallerSize(30_260_142)).toBe("30 MB");
    expect(formatInstallerSize(400_000)).toBe("1 MB");
    expect(formatInstallerSize(undefined)).toBeNull();
    expect(formatInstallerSize(0)).toBeNull();
  });
});

describe("the public release manifest", () => {
  it("round-trips the shipped table", () => {
    const wire = JSON.parse(JSON.stringify(releaseManifest()));
    expect(parseReleaseManifest(wire)).toEqual(DESKTOP_BUILDS);
  });

  it("carries no URL, so the app always builds its own links", () => {
    expect(JSON.stringify(releaseManifest())).not.toMatch(/https?:/);
  });

  it("refuses anything malformed rather than guessing", () => {
    const good = JSON.parse(JSON.stringify(releaseManifest(PUBLISHED)));
    const bad: unknown[] = [
      null,
      "nope",
      {},
      { builds: null },
      { builds: { ...good.builds, linux: undefined } },
      { builds: { ...good.builds, windows: { status: "published", version: "latest", sha256: SHA } } },
      { builds: { ...good.builds, windows: { status: "published", version: "0.1.0", sha256: "x" } } },
      { builds: { ...good.builds, windows: { status: "published", version: "0.1.0", sha256: SHA, bytes: -1 } } },
      { builds: { ...good.builds, windows: { status: "shipping" } } },
    ];
    for (const value of bad) expect(parseReleaseManifest(value), JSON.stringify(value)).toBeNull();
  });

  it("drops fields it does not know, such as a URL someone added", () => {
    const wire = {
      builds: {
        ...JSON.parse(JSON.stringify(releaseManifest(PUBLISHED))).builds,
        windows: { status: "published", version: "0.2.0", sha256: SHA, url: "https://evil.example/x.exe" },
      },
    };
    expect(parseReleaseManifest(wire)?.windows).toEqual({ status: "published", version: "0.2.0", sha256: SHA });
    expect(downloadUrl("windows", parseReleaseManifest(wire)!)).toBe(
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/desktop-v0.2.0/Hubble_0.2.0_x64-setup.exe`
    );
  });
});
