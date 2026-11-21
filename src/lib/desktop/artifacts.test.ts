import { describe, expect, it } from "vitest";
import {
  artifactHref,
  artifactUrl,
  buildsFromRelease,
  classifyAsset,
  findArtifact,
  isOfficialArtifactUrl,
  parseGithubRelease,
  pickLatestRelease,
  primaryArtifact,
  releaseFromBuilds,
} from "./artifacts";
import { DESKTOP_BUILDS, parseReleaseManifest } from "./release";

const SHA = "a".repeat(64);

function asset(name: string, extra: Record<string, unknown> = {}) {
  return { name, size: 31_000_000, state: "uploaded", digest: `sha256:${SHA}`, browser_download_url: "https://evil.example/x", ...extra };
}

function githubRelease(version: string, names: string[], extra: Record<string, unknown> = {}) {
  return { tag_name: `desktop-v${version}`, draft: false, prerelease: false, published_at: "2026-11-19T10:00:00Z", body: "- Notes", assets: names.map((name) => asset(name)), ...extra };
}

describe("classifyAsset", () => {
  it("knows each installer Tauri's bundlers name for this version, and nothing else", () => {
    expect(classifyAsset("Hubble_0.2.0_x64-setup.exe", "0.2.0")).toEqual({ os: "windows", format: "nsis", arch: "x64" });
    expect(classifyAsset("Hubble_0.2.0_x64_en-US.msi", "0.2.0")).toEqual({ os: "windows", format: "msi", arch: "x64" });
    expect(classifyAsset("Hubble_0.2.0_universal.dmg", "0.2.0")).toEqual({ os: "macos", format: "dmg", arch: "universal" });
    expect(classifyAsset("Hubble_0.2.0_aarch64.dmg", "0.2.0")).toEqual({ os: "macos", format: "dmg", arch: "arm64" });
    expect(classifyAsset("Hubble_0.2.0_amd64.AppImage", "0.2.0")).toEqual({ os: "linux", format: "appimage", arch: "x64" });
    expect(classifyAsset("Hubble_0.2.0_amd64.deb", "0.2.0")).toEqual({ os: "linux", format: "deb", arch: "x64" });
    expect(classifyAsset("Hubble-0.2.0-1.x86_64.rpm", "0.2.0")).toEqual({ os: "linux", format: "rpm", arch: "x64" });
    for (const name of [
      "Hubble_0.1.0_x64-setup.exe", // another version
      "Hubble_0.2.0_x64-setup.exe.sha256",
      "Hubble_0.2.0_x64-setup.exe.sig",
      "Hubble_0.2.0_x64-setup-debug.exe",
      "latest.json",
      "Hubble_0x2x0_x64-setup.exe", // dots are literal
      "../Hubble_0.2.0_x64-setup.exe",
    ]) {
      expect(classifyAsset(name, "0.2.0"), name).toBeNull();
    }
  });
});

describe("parseGithubRelease", () => {
  it("takes a published desktop release's installers, with GitHub's checksum and size, and builds every URL itself", () => {
    const release = parseGithubRelease(
      githubRelease("0.2.0", ["Hubble_0.2.0_x64-setup.exe", "Hubble_0.2.0_x64-setup.exe.sha256", "Hubble_0.2.0_amd64.AppImage", "Hubble_0.2.0_x64_en-US.msi", "notes.txt"])
    )!;
    expect(release.version).toBe("0.2.0");
    expect(release.source).toBe("github");
    expect(release.artifacts.map((artifact) => artifact.name)).toEqual(["Hubble_0.2.0_x64-setup.exe", "Hubble_0.2.0_x64_en-US.msi", "Hubble_0.2.0_amd64.AppImage"]);
    expect(release.artifacts[0]).toMatchObject({ bytes: 31_000_000, sha256: SHA });
    // GitHub's own download URL is never read: the page and the redirect build theirs.
    expect(JSON.stringify(release)).not.toContain("evil.example");
    expect(artifactUrl(release.version, release.artifacts[0]!.name)).toBe("https://github.com/Biterate-7/tabs/releases/download/desktop-v0.2.0/Hubble_0.2.0_x64-setup.exe");
  });

  it("refuses drafts, prereleases, other tags and releases with no installer", () => {
    expect(parseGithubRelease(githubRelease("0.2.0", ["Hubble_0.2.0_x64-setup.exe"], { draft: true }))).toBeNull();
    expect(parseGithubRelease(githubRelease("0.2.0", ["Hubble_0.2.0_x64-setup.exe"], { prerelease: true }))).toBeNull();
    expect(parseGithubRelease(githubRelease("0.2.0", ["Hubble_0.2.0_x64-setup.exe"], { tag_name: "v0.2.0" }))).toBeNull();
    expect(parseGithubRelease(githubRelease("0.2.0", ["README.md"]))).toBeNull();
    expect(parseGithubRelease({ ...githubRelease("0.2.0", []), assets: [asset("Hubble_0.2.0_x64-setup.exe", { state: "starter" })] })).toBeNull();
    expect(parseGithubRelease({ ...githubRelease("0.2.0", []), assets: [asset("Hubble_0.2.0_x64-setup.exe", { size: 0 })] })).toBeNull();
  });

  it("keeps an installer whose digest is missing, without inventing one", () => {
    const release = parseGithubRelease({ ...githubRelease("0.2.0", []), assets: [asset("Hubble_0.2.0_x64-setup.exe", { digest: null })] })!;
    expect(release.artifacts[0]!.sha256).toBeNull();
    // ...which old apps can't verify, so the manifest keeps the reviewed table for Windows.
    expect(buildsFromRelease(release).windows).toEqual(DESKTOP_BUILDS.windows);
  });
});

describe("pickLatestRelease", () => {
  it("takes the newest published desktop release by version, whatever order GitHub lists them in", () => {
    const latest = pickLatestRelease([
      githubRelease("0.1.0", ["Hubble_0.1.0_x64-setup.exe"]),
      githubRelease("0.3.0", ["Hubble_0.3.0_x64-setup.exe"], { draft: true }),
      githubRelease("0.2.0", ["Hubble_0.2.0_x64-setup.exe"]),
      { tag_name: "web-v9.0.0", draft: false, prerelease: false, assets: [] },
    ]);
    expect(latest?.version).toBe("0.2.0");
    expect(pickLatestRelease({ message: "rate limited" })).toBeNull();
  });
});

describe("what the site offers", () => {
  const release = parseGithubRelease(
    githubRelease("0.2.0", ["Hubble_0.2.0_x64_en-US.msi", "Hubble_0.2.0_x64-setup.exe", "Hubble_0.2.0_aarch64.dmg", "Hubble_0.2.0_universal.dmg", "Hubble_0.2.0_amd64.deb", "Hubble_0.2.0_amd64.AppImage"])
  )!;

  it("puts each OS's preferred installer first", () => {
    expect(primaryArtifact(release, "windows")?.format).toBe("nsis");
    expect(primaryArtifact(release, "macos")?.arch).toBe("universal");
    expect(primaryArtifact(release, "linux")?.format).toBe("appimage");
    expect(findArtifact(release, "windows", "msi")?.name).toBe("Hubble_0.2.0_x64_en-US.msi");
    expect(findArtifact(release, "macos", "dmg", "arm64")?.name).toBe("Hubble_0.2.0_aarch64.dmg");
    expect(findArtifact(release, "linux", "rpm")).toBeNull();
  });

  it("links the primary installer by platform alone, and any other by format and architecture", () => {
    expect(artifactHref(primaryArtifact(release, "windows")!, release)).toBe("/api/download?platform=windows");
    expect(artifactHref(findArtifact(release, "windows", "msi")!, release)).toBe("/api/download?platform=windows&format=msi&arch=x64");
  });

  it("keeps the manifest shipped apps parse, now following the live release", () => {
    const builds = buildsFromRelease(release);
    expect(builds.windows).toEqual({ status: "published", version: "0.2.0", sha256: SHA, bytes: 31_000_000 });
    expect(builds.macos).toEqual({ status: "unpublished" });
    expect(parseReleaseManifest({ builds })).toEqual(builds);
  });
});

describe("isOfficialArtifactUrl", () => {
  it("accepts only this repository's release installers", () => {
    expect(isOfficialArtifactUrl("https://github.com/Biterate-7/tabs/releases/download/desktop-v0.2.0/Hubble_0.2.0_amd64.AppImage")).toBe(true);
    expect(isOfficialArtifactUrl("https://github.com/Biterate-7/tabs/releases/download/desktop-v0.2.0/Hubble_0.3.0_amd64.AppImage")).toBe(false);
    expect(isOfficialArtifactUrl("https://github.com/someone/tabs/releases/download/desktop-v0.2.0/Hubble_0.2.0_amd64.AppImage")).toBe(false);
    expect(isOfficialArtifactUrl("https://github.com/Biterate-7/tabs/releases/download/desktop-v0.2.0/Hubble_0.2.0_amd64.AppImage?x=1")).toBe(false);
    expect(isOfficialArtifactUrl("http://github.com/Biterate-7/tabs/releases/download/desktop-v0.2.0/Hubble_0.2.0_amd64.AppImage")).toBe(false);
    expect(isOfficialArtifactUrl("https://github.com/Biterate-7/tabs/releases/download/desktop-v0.2.0/sub/Hubble_0.2.0_amd64.AppImage")).toBe(false);
  });
});

describe("releaseFromBuilds", () => {
  it("turns the reviewed table into the Windows installer it vouches for", () => {
    const release = releaseFromBuilds()!;
    expect(release.source).toBe("fallback");
    expect(release.artifacts).toHaveLength(1);
    expect(release.artifacts[0]!.name).toMatch(/^Hubble_\d+\.\d+\.\d+_x64-setup\.exe$/);
  });
});
