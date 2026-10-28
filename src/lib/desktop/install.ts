/**
 * Getting Hubble Desktop, and keeping it current — the network half of
 * Settings → Desktop app. What exists to download is decided in ./release.ts;
 * this file only asks the deployed site whether that is still true.
 *
 * Two questions, one per runtime:
 *
 *   - On the web, `probeDownload` asks the measured download endpoint whether
 *     it will redirect to an installer right now (HEAD, which is never
 *     counted), so the page can say "unavailable" or "can't reach Hubble"
 *     instead of sending someone to an error page.
 *   - In Hubble Desktop, `checkForDesktopUpdate` reads the deployed release
 *     manifest. The app's own copy of release.ts is frozen at the version it
 *     shipped with, so only the live site knows whether a newer build has
 *     been published since.
 *
 * Neither ever takes a URL from a response. Every link is built by
 * release.ts from a validated version number.
 */

import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs";
import {
  RELEASE_MANIFEST_PATH,
  compareVersions,
  downloadHref,
  parseReleaseManifest,
  releasePageUrl,
  type DesktopOs,
} from "./release";

const TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ *
 * Web: is the installer there?
 * ------------------------------------------------------------------ */

/**
 * - `available`: the endpoint answered with a redirect, which it only does
 *   to a published GitHub Release asset.
 * - `unavailable`: it answered, and there is no build to redirect to.
 * - `unreachable`: no answer (offline, blocked, the site is down) or one
 *   that isn't either of those.
 */
export type DownloadProbe = "available" | "unavailable" | "unreachable";

export async function probeDownload(href: string, fetchImpl: typeof fetch = fetch): Promise<DownloadProbe> {
  try {
    const response = await fetchImpl(href, {
      method: "HEAD",
      // The redirect itself is the answer. Following it would make a request
      // to GitHub for nothing, and a cross-origin HEAD there is not ours to rely on.
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return "available";
    if (response.status === 404) return "unavailable";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/* ------------------------------------------------------------------ *
 * Desktop: is there a newer build?
 * ------------------------------------------------------------------ */

export type UpdateCheck =
  /** The installed version is the latest published one. */
  | { kind: "current"; installed: string; latest: string }
  /** The installed build is newer than anything published — a build made before its release. */
  | { kind: "ahead"; installed: string; latest: string }
  /** A newer build is published. `downloadUrl` is the measured endpoint on the deployed site. */
  | { kind: "available"; installed: string; latest: string; downloadUrl: string; releaseUrl: string; bytes?: number }
  /** Nothing is published for this OS. */
  | { kind: "none"; installed: string }
  /** The check itself didn't complete. `message` is the sentence shown. */
  | { kind: "failed"; message: string };

export type UpdateCheckOptions = {
  installed: string;
  os: DesktopOs;
  fetchImpl?: typeof fetch;
  /** The deployed Hubble to ask. Production unless a test says otherwise. */
  origin?: string;
};

export async function checkForDesktopUpdate({
  installed,
  os,
  fetchImpl = fetch,
  origin = CANONICAL_PRODUCTION_ORIGIN,
}: UpdateCheckOptions): Promise<UpdateCheck> {
  let body: unknown;
  try {
    const response = await fetchImpl(`${origin}${RELEASE_MANIFEST_PATH}`, {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { kind: "failed", message: `Hubble's release server answered ${response.status}.` };
    body = await response.json();
  } catch {
    return { kind: "failed", message: "Couldn't reach Hubble's release server. Check your connection." };
  }

  const builds = parseReleaseManifest(body);
  if (!builds) return { kind: "failed", message: "Hubble's release server sent something unexpected." };

  const build = builds[os];
  const href = downloadHref(os, builds);
  if (build.status !== "published" || !href) return { kind: "none", installed };

  const order = compareVersions(installed, build.version);
  if (order === null) return { kind: "failed", message: `This build's version (${installed}) isn't one Hubble can compare.` };
  if (order === 0) return { kind: "current", installed, latest: build.version };
  if (order > 0) return { kind: "ahead", installed, latest: build.version };
  return {
    kind: "available",
    installed,
    latest: build.version,
    downloadUrl: `${origin}${href}`,
    releaseUrl: releasePageUrl(build.version),
    ...(build.bytes ? { bytes: build.bytes } : {}),
  };
}
