import {
  DESKTOP_BUILDS,
  RELEASE_REPOSITORY,
  RELEASES_PAGE_URL,
  compareVersions,
  releasePageUrl,
  releaseTag,
  windowsInstallerName,
  type DesktopBuild,
  type DesktopOs,
} from "./release";

/**
 * Hubble Desktop's installers, as a published GitHub Release lists them.
 *
 * `release.ts` holds the reviewed fallback table and the rules every link
 * obeys. This module adds what that table could not say: which *files* a
 * release really has, for every OS, read from the release itself — so the
 * website follows a newly published release without a pull request, and a
 * platform appears on the site only once an installer for it is public.
 *
 * ## Nothing is trusted that the release says
 *
 * A release is taken only when it is published (not a draft, not a
 * prerelease) and its tag is `desktop-vX.Y.Z`. An asset is taken only when
 * its name is exactly one of the file names Tauri's bundlers produce for
 * *that* version (`classifyAsset`); everything else — debug builds, logs,
 * checksum files, a renamed upload — is ignored. No URL is ever read from
 * GitHub's answer: each download URL is rebuilt here from the version and
 * the file name and re-checked by `isOfficialArtifactUrl`. Sizes must be
 * positive integers and checksums 64 hex characters, or they are dropped.
 */

export type ArtifactFormat = "nsis" | "msi" | "dmg" | "appimage" | "deb" | "rpm";
export type ArtifactArch = "x64" | "arm64" | "universal";

export type DesktopArtifact = {
  os: DesktopOs;
  format: ArtifactFormat;
  arch: ArtifactArch;
  /** The file name, exactly as published. */
  name: string;
  /** Size in bytes as GitHub lists the asset; 0 when unknown (the fallback table). */
  bytes: number;
  /** SHA-256 of the file (GitHub's asset digest), or null when the release does not say. */
  sha256: string | null;
};

export type DesktopRelease = {
  version: string;
  tag: string;
  /** ISO time the release was published, when known. */
  publishedAt: string | null;
  /** The release notes as plain text (Markdown source). Never rendered as HTML. */
  notes: string;
  artifacts: DesktopArtifact[];
  /** Where this came from: the live GitHub release, or the reviewed table in release.ts. */
  source: "github" | "fallback";
};

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TAG = /^desktop-v(\d+\.\d+\.\d+)$/;

/** Formats in the order each OS prefers them: the first one present is the primary download. */
export const FORMAT_PREFERENCE: Record<DesktopOs, readonly ArtifactFormat[]> = {
  windows: ["nsis", "msi"],
  macos: ["dmg"],
  linux: ["appimage", "deb", "rpm"],
};

export const FORMAT_LABEL: Record<ArtifactFormat, string> = {
  nsis: "Installer (.exe)",
  msi: "Windows Installer (.msi)",
  dmg: "Disk image (.dmg)",
  appimage: "AppImage",
  deb: "Debian / Ubuntu (.deb)",
  rpm: "Fedora / RHEL (.rpm)",
};

export const ARCH_LABEL: Record<ArtifactArch, string> = {
  x64: "64-bit (x64)",
  arm64: "Apple silicon / ARM64",
  universal: "Apple silicon and Intel",
};

function escapeVersion(version: string): string {
  return version.replace(/\./g, "\\.");
}

/**
 * What an asset is, from its name — or `null` for anything that is not an
 * installer of `version`. The patterns are Tauri 2's bundler output names
 * for productName "Hubble"; the release workflow uploads them unchanged.
 */
export function classifyAsset(name: string, version: string): { os: DesktopOs; format: ArtifactFormat; arch: ArtifactArch } | null {
  if (!VERSION.test(version) || typeof name !== "string" || name.length > 200) return null;
  const v = escapeVersion(version);
  const rules: { pattern: RegExp; os: DesktopOs; format: ArtifactFormat; arch: (match: RegExpMatchArray) => ArtifactArch | null }[] = [
    { pattern: new RegExp(`^Hubble_${v}_(x64|arm64)-setup\\.exe$`), os: "windows", format: "nsis", arch: (m) => (m[1] === "arm64" ? "arm64" : "x64") },
    { pattern: new RegExp(`^Hubble_${v}_(x64|arm64)_en-US\\.msi$`), os: "windows", format: "msi", arch: (m) => (m[1] === "arm64" ? "arm64" : "x64") },
    { pattern: new RegExp(`^Hubble_${v}_(aarch64|x64|universal)\\.dmg$`), os: "macos", format: "dmg", arch: (m) => (m[1] === "aarch64" ? "arm64" : m[1] === "universal" ? "universal" : "x64") },
    { pattern: new RegExp(`^Hubble_${v}_(amd64|aarch64)\\.AppImage$`), os: "linux", format: "appimage", arch: (m) => (m[1] === "aarch64" ? "arm64" : "x64") },
    { pattern: new RegExp(`^Hubble_${v}_(amd64|arm64)\\.deb$`), os: "linux", format: "deb", arch: (m) => (m[1] === "arm64" ? "arm64" : "x64") },
    { pattern: new RegExp(`^Hubble-${v}-1\\.(x86_64|aarch64)\\.rpm$`), os: "linux", format: "rpm", arch: (m) => (m[1] === "aarch64" ? "arm64" : "x64") },
  ];
  for (const rule of rules) {
    const match = name.match(rule.pattern);
    if (!match) continue;
    const arch = rule.arch(match);
    return arch ? { os: rule.os, format: rule.format, arch } : null;
  }
  return null;
}

/** The download URL for one artifact of `version`: this repository's GitHub Releases, built here, never read. */
export function artifactUrl(version: string, name: string): string | null {
  if (!classifyAsset(name, version)) return null;
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseTag(version)}/${name}`;
  return isOfficialArtifactUrl(url) ? url : null;
}

/**
 * Whether `url` is an installer on one of this repository's GitHub Releases:
 * exact host, path shape, a tag that names a version and a file name that is
 * an installer of that same version. No query, fragment or credentials.
 */
export function isOfficialArtifactUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.host !== "github.com") return false;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
  const prefix = `/${RELEASE_REPOSITORY}/releases/download/`;
  if (!parsed.pathname.startsWith(prefix)) return false;
  const rest = parsed.pathname.slice(prefix.length).split("/");
  if (rest.length !== 2) return false;
  const tag = rest[0]!.match(TAG);
  if (!tag) return false;
  return classifyAsset(rest[1]!, tag[1]!) !== null;
}

/* ------------------------------------------------------------------ *
 * Reading GitHub's answer
 * ------------------------------------------------------------------ */

/** One release from `GET /repos/{owner}/{repo}/releases`, read strictly. `null` unless it is a published desktop release with at least one installer. */
export function parseGithubRelease(value: unknown): DesktopRelease | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.draft !== false || raw.prerelease !== false) return null;
  if (typeof raw.tag_name !== "string") return null;
  const tag = raw.tag_name.match(TAG);
  if (!tag) return null;
  const version = tag[1]!;
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  const artifacts: DesktopArtifact[] = [];
  const names = new Set<string>();
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue;
    const a = asset as Record<string, unknown>;
    if (typeof a.name !== "string" || names.has(a.name)) continue;
    if (a.state !== undefined && a.state !== "uploaded") continue;
    const kind = classifyAsset(a.name, version);
    if (!kind) continue;
    const bytes = typeof a.size === "number" && Number.isSafeInteger(a.size) && a.size > 0 ? a.size : 0;
    if (bytes === 0) continue;
    const digest = typeof a.digest === "string" ? a.digest.replace(/^sha256:/, "") : "";
    names.add(a.name);
    artifacts.push({ ...kind, name: a.name, bytes, sha256: SHA256.test(digest) ? digest : null });
  }
  if (artifacts.length === 0) return null;
  const publishedAt = typeof raw.published_at === "string" && !Number.isNaN(Date.parse(raw.published_at)) ? raw.published_at : null;
  const notes = typeof raw.body === "string" ? raw.body.slice(0, 8000) : "";
  return { version, tag: releaseTag(version), publishedAt, notes, artifacts: sortArtifacts(artifacts), source: "github" };
}

/** The newest published desktop release in a list of GitHub releases, by version. */
export function pickLatestRelease(list: unknown): DesktopRelease | null {
  if (!Array.isArray(list)) return null;
  let best: DesktopRelease | null = null;
  for (const entry of list) {
    const release = parseGithubRelease(entry);
    if (!release) continue;
    if (!best || (compareVersions(release.version, best.version) ?? 0) > 0) best = release;
  }
  return best;
}

/** The reviewed table in release.ts as a release, for when GitHub can't be reached. Windows NSIS only, as that table says. */
export function releaseFromBuilds(builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): DesktopRelease | null {
  const windows = builds.windows;
  // The table is reviewed by hand: a malformed entry offers nothing rather than an unverifiable download.
  if (windows.status !== "published" || !VERSION.test(windows.version) || !SHA256.test(windows.sha256)) return null;
  return {
    version: windows.version,
    tag: releaseTag(windows.version),
    publishedAt: null,
    notes: "",
    artifacts: [
      { os: "windows", format: "nsis", arch: "x64", name: windowsInstallerName(windows.version), bytes: windows.bytes ?? 0, sha256: windows.sha256 },
    ],
    source: "fallback",
  };
}

function sortArtifacts(artifacts: DesktopArtifact[]): DesktopArtifact[] {
  const osOrder: DesktopOs[] = ["windows", "macos", "linux"];
  const archOrder: ArtifactArch[] = ["universal", "x64", "arm64"];
  return [...artifacts].sort(
    (a, b) =>
      osOrder.indexOf(a.os) - osOrder.indexOf(b.os) ||
      FORMAT_PREFERENCE[a.os].indexOf(a.format) - FORMAT_PREFERENCE[b.os].indexOf(b.format) ||
      archOrder.indexOf(a.arch) - archOrder.indexOf(b.arch)
  );
}

/* ------------------------------------------------------------------ *
 * What the site offers
 * ------------------------------------------------------------------ */

export function artifactsFor(release: DesktopRelease | null, os: DesktopOs): DesktopArtifact[] {
  return release ? release.artifacts.filter((artifact) => artifact.os === os) : [];
}

/** The one download to put first for an OS: its preferred format, x64/universal before ARM. */
export function primaryArtifact(release: DesktopRelease | null, os: DesktopOs): DesktopArtifact | null {
  return artifactsFor(release, os)[0] ?? null;
}

/** Find an artifact by what a download link asks for. Without `format`/`arch`, the OS's primary download. */
export function findArtifact(release: DesktopRelease | null, os: DesktopOs, format?: ArtifactFormat, arch?: ArtifactArch): DesktopArtifact | null {
  const candidates = artifactsFor(release, os).filter((artifact) => (!format || artifact.format === format) && (!arch || artifact.arch === arch));
  return candidates[0] ?? null;
}

export const ARTIFACT_FORMATS: readonly ArtifactFormat[] = ["nsis", "msi", "dmg", "appimage", "deb", "rpm"];
export const ARTIFACT_ARCHES: readonly ArtifactArch[] = ["x64", "arm64", "universal"];

export function parseArtifactFormat(value: string | null | undefined): ArtifactFormat | null {
  return ARTIFACT_FORMATS.find((format) => format === value) ?? null;
}

export function parseArtifactArch(value: string | null | undefined): ArtifactArch | null {
  return ARTIFACT_ARCHES.find((arch) => arch === value) ?? null;
}

/** The site's measured link for one artifact (src/app/api/download/route.ts), never the GitHub URL itself. */
export function artifactHref(artifact: Pick<DesktopArtifact, "os" | "format" | "arch">, release: DesktopRelease | null): string {
  const primary = release ? primaryArtifact(release, artifact.os) : null;
  if (primary && primary.format === artifact.format && primary.arch === artifact.arch) return `/api/download?platform=${artifact.os}`;
  return `/api/download?platform=${artifact.os}&format=${artifact.format}&arch=${artifact.arch}`;
}

export function releaseNotesUrl(release: DesktopRelease | null): string {
  return release ? releasePageUrl(release.version) : RELEASES_PAGE_URL;
}

/**
 * The table installed Hubble Desktop apps read from `/api/desktop/release`
 * (release.ts `parseReleaseManifest`), derived from the live release so an
 * app hears about a new version without a pull request. Only an OS with a
 * checksummed primary installer that old apps can name (`Hubble_X_x64-setup.exe`)
 * is "published"; every other OS keeps its reviewed status.
 */
export function buildsFromRelease(release: DesktopRelease | null, fallback: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): Record<DesktopOs, DesktopBuild> {
  const builds: Record<DesktopOs, DesktopBuild> = { ...fallback };
  if (!release) return builds;
  const windows = release.artifacts.find((artifact) => artifact.os === "windows" && artifact.format === "nsis" && artifact.arch === "x64");
  if (windows?.sha256) builds.windows = { status: "published", version: release.version, sha256: windows.sha256, ...(windows.bytes > 0 ? { bytes: windows.bytes } : {}) };
  for (const os of ["macos", "linux"] as const) {
    if (artifactsFor(release, os).length > 0 && builds[os].status !== "published") builds[os] = { status: "unpublished" };
  }
  return builds;
}

/** A serializable summary for client components and the public manifest. */
export type ReleaseView = DesktopRelease & { pageUrl: string };

export function releaseView(release: DesktopRelease | null): ReleaseView | null {
  return release ? { ...release, pageUrl: releaseNotesUrl(release) } : null;
}
