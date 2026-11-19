import "server-only";
import { pickLatestRelease, releaseFromBuilds, type DesktopRelease } from "./artifacts";
import { RELEASE_REPOSITORY } from "./release";

/**
 * The latest published Hubble Desktop release, as GitHub lists it.
 *
 * The website asks GitHub's REST API for this repository's releases and
 * takes the newest published `desktop-vX.Y.Z` one (artifacts.ts reads it
 * strictly). Publishing a release on GitHub is therefore all it takes for
 * `/`, `/download`, `/api/download` and `/api/desktop/release` to follow
 * it — within `RELEASE_REVALIDATE_SECONDS`, with no deploy.
 *
 * When GitHub can't be reached, answers with an error, or has no published
 * desktop release, the reviewed table in release.ts is used instead
 * (`source: "fallback"`), so the site never goes without a download it had
 * yesterday, and never offers one that table does not vouch for.
 *
 * Unauthenticated: the endpoint is public, and the answer is cached by
 * Next's data cache, so the site makes a handful of requests an hour. A
 * read-only `GITHUB_RELEASES_TOKEN`, when set, raises GitHub's rate limit;
 * it is optional and never needed for correctness.
 */

export const RELEASE_REVALIDATE_SECONDS = 600;

const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=30`;

export async function getLatestDesktopRelease(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<DesktopRelease | null> {
  const fetchImpl = options.fetch ?? fetch;
  const token = process.env.GITHUB_RELEASES_TOKEN;
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hubble-website",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      next: { revalidate: RELEASE_REVALIDATE_SECONDS, tags: ["desktop-release"] },
    } as RequestInit);
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const latest = pickLatestRelease(await response.json());
    if (latest) return latest;
  } catch (error) {
    console.warn(`[desktop-release] using the reviewed release table: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return releaseFromBuilds();
}
