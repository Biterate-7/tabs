/**
 * Hubble Desktop's public builds — the one place the website learns whether
 * there is anything to download, and from where.
 *
 * ## Nothing here is fetched, and nothing is taken from input
 *
 * A download URL is built from three constants and a version number written
 * in this file, never from a query string, a header, a runtime response or an
 * environment variable. The only host it can name is this repository's GitHub
 * Releases, and `isOfficialReleaseUrl` re-checks that before any link is
 * rendered. A build is `published` only after a person has published the
 * GitHub Release the release workflow drafts (docs/desktop-release.md) — the
 * website never links to an installer that is not already public.
 *
 * ## Why the statuses are written by hand
 *
 * `src-tauri/tauri.conf.json` says what *can* be built (Windows NSIS/MSI
 * only). Whether a build has been signed off and published is a human
 * decision, recorded here in the same pull request that turns the link on, so
 * the claim and the artifact are reviewed together.
 */

/** Where every official Hubble Desktop build is published. */
export const RELEASE_REPOSITORY = "Biterate-7/tabs" as const;

export type DesktopOs = "windows" | "macos" | "linux";

export const DESKTOP_OSES: readonly DesktopOs[] = ["windows", "macos", "linux"];

/** A `platform` value from a request, if it is exactly one Hubble knows. Nothing is normalised. */
export function parseDesktopOs(value: string | null | undefined): DesktopOs | null {
  return DESKTOP_OSES.find((os) => os === value) ?? null;
}

export type DesktopBuild =
  /** A real installer, on a published GitHub Release. */
  | {
      status: "published";
      /** `src-tauri/tauri.conf.json` `version` of the build. */
      version: string;
      /** SHA-256 of the installer, as the release workflow recorded it. */
      sha256: string;
      /** The installer's size in bytes, as GitHub lists the asset. Shown beside the download, never used to build a link. */
      bytes?: number;
    }
  /** The app builds for this OS, but no installer has been published yet. */
  | { status: "unpublished" }
  /** Planned, with no build configuration in this repository yet. */
  | { status: "coming_soon" }
  /** Not built for this OS. */
  | { status: "unsupported" };

/**
 * The state of every desktop OS, as of this commit.
 *
 * To publish Windows: run the release workflow, install the drafted
 * installer, publish the draft, then change `windows` to
 * `{ status: "published", version, sha256, bytes }`. See docs/desktop-release.md.
 */
export const DESKTOP_BUILDS: Readonly<Record<DesktopOs, DesktopBuild>> = {
  // https://github.com/Biterate-7/tabs/releases/tag/desktop-v0.1.0 — published
  // 2026-10-01. The checksum is the published asset's, verified after download;
  // the size is GitHub's listing of the same asset.
  windows: {
    status: "published",
    version: "0.1.0",
    sha256: "660326fd1312727ba4edef5cc17a2755ae437e31674ac12d4359ac67174dc9d3",
    bytes: 30_260_142,
  },
  macos: { status: "coming_soon" },
  linux: { status: "unsupported" },
};

export const DESKTOP_OS_LABEL: Record<DesktopOs, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

/** What each OS's build needs, said only beside a build that exists. */
export const DESKTOP_REQUIREMENTS: Record<DesktopOs, string> = {
  windows: "Windows 10 or 11, 64-bit",
  macos: "",
  linux: "",
};

/** The Git tag the release workflow builds a version from. */
export function releaseTag(version: string): string {
  return `desktop-v${version}`;
}

/**
 * The installer's file name. Tauri's NSIS bundler names it
 * `{productName}_{version}_{arch}-setup.exe`, and the release workflow
 * uploads it unchanged.
 */
export function windowsInstallerName(version: string): string {
  return `Hubble_${version}_x64-setup.exe`;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The download URL for a published build, or `null` when there is nothing
 * real to link to. Never a preview deployment, never a path on this site.
 */
export function downloadUrl(os: DesktopOs, builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): string | null {
  const build = builds[os];
  if (build.status !== "published") return null;
  // Only Windows has an installer format the release workflow produces.
  if (os !== "windows") return null;
  if (!VERSION.test(build.version) || !SHA256.test(build.sha256)) return null;
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseTag(build.version)}/${windowsInstallerName(build.version)}`;
  return isOfficialReleaseUrl(url) ? url : null;
}

/**
 * The measured download endpoint (src/app/api/download/route.ts). Every
 * download link on the site points here, never at GitHub directly: the
 * endpoint counts the download, then redirects to `downloadUrl`.
 */
export const DOWNLOAD_ENDPOINT = "/api/download";

/** Where a download link for `os` points, or `null` when there is no published build to download. */
export function downloadHref(os: DesktopOs, builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): string | null {
  return downloadUrl(os, builds) ? `${DOWNLOAD_ENDPOINT}?platform=${os}` : null;
}

/**
 * Whether `url` is an asset on one of this repository's GitHub Releases.
 * Exact origin and path shape — no other host, no redirects of our own, no
 * query or fragment.
 */
export function isOfficialReleaseUrl(url: string): boolean {
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
  return /^desktop-v\d+\.\d+\.\d+\/Hubble_\d+\.\d+\.\d+_x64-setup\.exe$/.test(parsed.pathname.slice(prefix.length));
}

/** Every Hubble Desktop release, on GitHub — the fallback whenever a download can't be started from Hubble itself. */
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;

/** One version's release page (notes, checksum, installer), or the list of releases for a version that isn't one. */
export function releasePageUrl(version: string): string {
  return VERSION.test(version) ? `${RELEASES_PAGE_URL}/tag/${releaseTag(version)}` : RELEASES_PAGE_URL;
}

/** Orders two `major.minor.patch` versions: negative when `a` is older. `null` if either isn't one. */
export function compareVersions(a: string, b: string): number | null {
  if (!VERSION.test(a) || !VERSION.test(b)) return null;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * The public manifest
 * ------------------------------------------------------------------ */

/**
 * `GET /api/desktop/release` (src/app/api/desktop/release/route.ts): this
 * table, served by the deployed site so an installed Hubble Desktop can learn
 * whether a newer build has been published since it was built. The desktop
 * app's own copy of `DESKTOP_BUILDS` is frozen at the version it shipped
 * with, so it cannot answer that question itself.
 */
export const RELEASE_MANIFEST_PATH = "/api/desktop/release";

export type ReleaseManifest = { builds: Record<DesktopOs, DesktopBuild> };

export function releaseManifest(builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): ReleaseManifest {
  return { builds: { ...builds } };
}

/**
 * Reads a manifest from the network, strictly. Only a status and, for a
 * published build, a well-formed version, checksum and size are taken: no
 * URL is ever read from it, so every link the app shows is still built here
 * (`downloadUrl`, `releasePageUrl`) and still checked by
 * `isOfficialReleaseUrl`. Anything malformed is `null`, never a guess.
 */
export function parseReleaseManifest(value: unknown): Record<DesktopOs, DesktopBuild> | null {
  if (!value || typeof value !== "object") return null;
  const builds = (value as { builds?: unknown }).builds;
  if (!builds || typeof builds !== "object") return null;
  const parsed = {} as Record<DesktopOs, DesktopBuild>;
  for (const os of DESKTOP_OSES) {
    const build = parseBuild((builds as Record<string, unknown>)[os]);
    if (!build) return null;
    parsed[os] = build;
  }
  return parsed;
}

function parseBuild(value: unknown): DesktopBuild | null {
  if (!value || typeof value !== "object") return null;
  const { status, version, sha256, bytes } = value as Record<string, unknown>;
  switch (status) {
    case "unpublished":
    case "coming_soon":
    case "unsupported":
      return { status };
    case "published":
      if (typeof version !== "string" || !VERSION.test(version)) return null;
      if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
      if (bytes !== undefined && !(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0)) return null;
      return { status, version, sha256, ...(typeof bytes === "number" ? { bytes } : {}) };
    default:
      return null;
  }
}

/** "30 MB" — an installer's size, for the line beside its download. */
export function formatInstallerSize(bytes: number | undefined): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** Whether any OS has a published build. */
export function anyDesktopBuildPublished(builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): boolean {
  return (Object.keys(builds) as DesktopOs[]).some((os) => downloadUrl(os, builds) !== null);
}

/* ------------------------------------------------------------------ *
 * Platform detection
 * ------------------------------------------------------------------ */

/** The visitor's OS, as far as a desktop download is concerned. */
export type VisitorOs = DesktopOs | "mobile" | "unknown";

/**
 * The visitor's OS, from what the browser reports.
 *
 * A hint for which button to put first, never a gate: every build stays
 * listed whatever this answers. Phones and tablets are `mobile` — Hubble
 * Desktop is for a computer — and that includes an iPad, which reports
 * itself as a Mac but has a touch screen.
 */
export function detectVisitorOs(input: {
  userAgent?: string;
  /** `navigator.userAgentData.platform`, where the browser has it. */
  platform?: string;
  maxTouchPoints?: number;
}): VisitorOs {
  const hint = (input.platform ?? "").toLowerCase();
  const ua = (input.userAgent ?? "").toLowerCase();
  if (/android|iphone|ipad|ipod/.test(hint) || /android|iphone|ipad|ipod|mobile/.test(ua)) return "mobile";
  if (hint === "windows" || /windows nt/.test(ua)) return "windows";
  if (hint === "macos" || /macintosh|mac os x/.test(ua)) {
    return (input.maxTouchPoints ?? 0) > 1 ? "mobile" : "macos";
  }
  if (hint === "chrome os" || /cros/.test(ua)) return "unknown";
  if (hint === "linux" || /linux|x11/.test(ua)) return "linux";
  return "unknown";
}

/** Reads the current browser. Call from an effect or handler, never during render. */
export function currentVisitorOs(): VisitorOs {
  if (typeof navigator === "undefined") return "unknown";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return detectVisitorOs({
    userAgent: navigator.userAgent,
    ...(data?.platform ? { platform: data.platform } : {}),
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

/* ------------------------------------------------------------------ *
 * What the website offers
 * ------------------------------------------------------------------ */

/**
 * The download page's primary action for a visitor.
 *
 *   - `download` — a real installer for their OS. `href` is the measured
 *     endpoint, which redirects to the GitHub Release asset.
 *   - `unavailable` — their OS has no public build. `reason` is the sentence shown.
 *   - `choose` — OS unknown (or a phone), so the builds are listed instead.
 */
export type DesktopOffer =
  | { kind: "download"; os: DesktopOs; label: string; href: string; version: string; requirements: string; sha256: string }
  | { kind: "unavailable"; os: DesktopOs; label: string; reason: string }
  | { kind: "choose"; label: string; reason: string };

export function desktopOffer(visitor: VisitorOs, builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): DesktopOffer {
  if (visitor === "mobile" || visitor === "unknown") {
    return {
      kind: "choose",
      label: "Download Hubble Desktop",
      reason:
        visitor === "mobile"
          ? "Hubble Desktop runs on a computer. Open this page there to download it."
          : anyDesktopBuildPublished(builds)
            ? "Choose your platform below."
            : "Hubble Desktop is not publicly available yet.",
    };
  }
  const build = builds[visitor];
  const href = downloadHref(visitor, builds);
  const name = DESKTOP_OS_LABEL[visitor];
  if (href && build.status === "published") {
    return {
      kind: "download",
      os: visitor,
      label: `Download Hubble for ${name}`,
      href,
      version: build.version,
      requirements: DESKTOP_REQUIREMENTS[visitor],
      sha256: build.sha256,
    };
  }
  return { kind: "unavailable", os: visitor, label: `Hubble for ${name}`, reason: statusSentence(visitor, builds) };
}

/** One short phrase per OS, for the list of platforms. */
export function statusLabel(os: DesktopOs, builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): string {
  const build = builds[os];
  if (downloadUrl(os, builds) && build.status === "published") return `Version ${build.version}`;
  switch (build.status) {
    case "published":
    case "unpublished":
      return "Not yet available";
    case "coming_soon":
      return "Coming soon";
    case "unsupported":
      return "Not available";
  }
}

function statusSentence(os: DesktopOs, builds: Readonly<Record<DesktopOs, DesktopBuild>>): string {
  const name = DESKTOP_OS_LABEL[os];
  switch (builds[os].status) {
    case "published":
    case "unpublished":
      return `The ${name} build is not publicly available yet.`;
    case "coming_soon":
      return `Hubble for ${name} is coming soon.`;
    case "unsupported":
      return `Hubble Desktop is not available for ${name}.`;
  }
}

/**
 * The words on a link *to* the download page, so a link never promises a
 * download that does not exist.
 */
export function desktopLinkLabel(builds: Readonly<Record<DesktopOs, DesktopBuild>> = DESKTOP_BUILDS): string {
  return anyDesktopBuildPublished(builds) ? "Download Hubble" : "Hubble Desktop";
}

/** The site's download page. */
export const DOWNLOAD_PATH = "/download";
