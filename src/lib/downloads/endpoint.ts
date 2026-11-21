import { DESKTOP_BUILDS, parseDesktopOs, type DesktopBuild, type DesktopOs } from "@/lib/desktop/release";
import {
  artifactUrl,
  findArtifact,
  isOfficialArtifactUrl,
  parseArtifactArch,
  parseArtifactFormat,
  releaseFromBuilds,
  type DesktopRelease,
} from "@/lib/desktop/artifacts";
import { utcDay, type DownloadCounter } from "./counter";

/**
 * `GET /api/download?platform=<os>[&format=<format>&arch=<arch>]` — count
 * one Hubble Desktop download, then redirect to its GitHub Release asset.
 *
 * ## Where the redirect goes
 *
 * Only to an installer of the latest published release
 * (src/lib/desktop/release-source.ts, read strictly by artifacts.ts): this
 * repository's GitHub Releases, at a URL rebuilt from the version and an
 * exact installer file name and re-checked by `isOfficialArtifactUrl`. The
 * request chooses a platform — and optionally a format and architecture —
 * from fixed lists and nothing else. A request with any other parameter is
 * refused rather than ignored, so no future change can quietly start
 * honouring `?url=` or `?to=`.
 *
 * ## What is counted
 *
 * One aggregate row per (UTC day, platform, version) gets +1 (./schema.sql).
 * Nothing about the requester is read into it. A download counts only when
 * all of these hold: the method is GET; the request is not a speculative
 * prefetch (`Sec-Purpose`/`Purpose: prefetch`, Next's router prefetch); the
 * user agent does not call itself a bot, crawler or link previewer; and the
 * platform has a published build to redirect to. HEAD gets the same redirect
 * and counts nothing. The user agent is read only to make that decision and
 * is never stored.
 *
 * A counting failure never costs the visitor their download: the redirect
 * still happens, and the failure is logged (without request details).
 */

const CACHE_HEADERS = {
  // The destination follows release.ts, which changes with each deploy. A
  // cached redirect would also send repeat clicks past the counter.
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex",
} as const;

const BOT_USER_AGENT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|monitor|curl|wget|python-requests|httpclient/i;

export type DownloadRequestResult =
  | { outcome: "redirect"; counted: boolean; platform: DesktopOs; version: string }
  | { outcome: "refused"; status: 400 | 404 | 405; code: DownloadRefusal };

export type DownloadRefusal = "unexpected-parameter" | "unknown-platform" | "not-available" | "method-not-allowed";

const REFUSAL_MESSAGES: Record<DownloadRefusal, string> = {
  "unexpected-parameter": "This download link takes a platform, and optionally a format and an architecture.",
  "unknown-platform": "Hubble Desktop has no build for that platform.",
  "not-available": "Hubble Desktop is not available to download for that platform yet.",
  "method-not-allowed": "Use GET to download Hubble Desktop.",
};

export type DownloadEndpointDeps = {
  counter: () => Promise<DownloadCounter | undefined>;
  /** The latest published release. Defaults to the reviewed table (`builds`). */
  release?: () => Promise<DesktopRelease | null>;
  /** The reviewed table, used when no `release` source is given. */
  builds?: Readonly<Record<DesktopOs, DesktopBuild>>;
  now?: () => number;
  /** Where a counting failure is reported. Defaults to console.error. */
  reportFailure?: (message: string) => void;
};

/** Whether this request is one a person made to download, rather than a prefetch, a preview or a probe. */
export function isCountableDownloadRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""} ${request.headers.get("x-purpose") ?? ""} ${request.headers.get("x-moz") ?? ""}`;
  if (/prefetch|prerender|preview/i.test(purpose)) return false;
  if (request.headers.has("next-router-prefetch")) return false;
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!userAgent || BOT_USER_AGENT.test(userAgent)) return false;
  return true;
}

export async function handleDownloadRequest(request: Request, deps: DownloadEndpointDeps): Promise<Response> {
  const { response } = await resolveDownloadRequest(request, deps);
  return response;
}

/** The handler, also returning what it decided — for tests and logs. */
export async function resolveDownloadRequest(
  request: Request,
  deps: DownloadEndpointDeps
): Promise<{ response: Response; result: DownloadRequestResult }> {
  if (request.method !== "GET" && request.method !== "HEAD") return refuse("method-not-allowed", 405);

  const params = new URL(request.url).searchParams;
  const allowed = new Set(["platform", "format", "arch"]);
  const keys = [...params.keys()];
  if (!keys.includes("platform") || keys.some((key) => !allowed.has(key) || params.getAll(key).length !== 1)) {
    return refuse("unexpected-parameter", 400);
  }
  const platform = parseDesktopOs(params.get("platform"));
  if (!platform) return refuse("unknown-platform", 400);
  const format = params.has("format") ? parseArtifactFormat(params.get("format")) : undefined;
  const arch = params.has("arch") ? parseArtifactArch(params.get("arch")) : undefined;
  if (format === null || arch === null) return refuse("unexpected-parameter", 400);

  const release = deps.release ? await deps.release() : releaseFromBuilds(deps.builds ?? DESKTOP_BUILDS);
  const artifact = findArtifact(release, platform, format, arch);
  const destination = release && artifact ? artifactUrl(release.version, artifact.name) : null;
  // artifactUrl already re-checks; asserted again here because this is the
  // one line in the codebase that sends a visitor to another site.
  if (!release || !destination || !isOfficialArtifactUrl(destination)) {
    return refuse("not-available", 404);
  }
  const build = { version: release.version };

  let counted = false;
  if (isCountableDownloadRequest(request)) {
    try {
      const counter = await deps.counter();
      if (counter) {
        await counter.record({ day: utcDay((deps.now ?? Date.now)()), platform, version: build.version });
        counted = true;
      }
    } catch (error) {
      (deps.reportFailure ?? ((message) => console.error(message)))(
        `[downloads] could not count a ${platform} ${build.version} download: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  return {
    response: new Response(null, { status: 302, headers: { Location: destination, ...CACHE_HEADERS } }),
    result: { outcome: "redirect", counted, platform, version: build.version },
  };
}

function refuse(code: DownloadRefusal, status: 400 | 404 | 405): { response: Response; result: DownloadRequestResult } {
  return {
    response: Response.json(
      { ok: false, error: { code, message: REFUSAL_MESSAGES[code] } },
      { status, headers: { ...CACHE_HEADERS, ...(status === 405 ? { Allow: "GET, HEAD" } : {}) } }
    ),
    result: { outcome: "refused", status, code },
  };
}
