import { buildsFromRelease, releaseView } from "@/lib/desktop/artifacts";
import { getLatestDesktopRelease } from "@/lib/desktop/release-source";

export const revalidate = 600;

/**
 * GET /api/desktop/release → the latest published Hubble Desktop release.
 *
 * Read by an installed Hubble Desktop to check for a newer version
 * (src/lib/desktop/install.ts), and usable by anything else that wants to
 * know what the download page offers. The answer follows the GitHub release
 * itself (src/lib/desktop/release-source.ts), so publishing a release is
 * enough for installed apps to hear of it.
 *
 * `builds` keeps the shape every shipped app parses (release.ts
 * `parseReleaseManifest`); `release` adds the full list of installers for
 * every OS. Neither names a URL: apps and pages build each link from the
 * version and file name and check it. Public and cookie-free — it says only
 * what /download already says — hence `Access-Control-Allow-Origin: *`.
 */
export async function GET(): Promise<Response> {
  const release = await getLatestDesktopRelease();
  const view = releaseView(release);
  return Response.json(
    {
      builds: buildsFromRelease(release),
      release: view && { version: view.version, tag: view.tag, publishedAt: view.publishedAt, source: view.source, artifacts: view.artifacts },
    },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300, s-maxage=600",
        "x-robots-tag": "noindex",
      },
    }
  );
}
