import { releaseManifest } from "@/lib/desktop/release";

/**
 * GET /api/desktop/release → which Hubble Desktop builds are published, as
 * of this deployment (src/lib/desktop/release.ts).
 *
 * Read by an installed Hubble Desktop to check for a newer version
 * (src/lib/desktop/install.ts): the app's own copy of that table is frozen at
 * the version it shipped with. Public and cookie-free — it says only what the
 * /download page already says — hence `Access-Control-Allow-Origin: *`. It
 * names no URL: the app builds every link itself from the version.
 */
export function GET(): Response {
  return Response.json(releaseManifest(), {
    headers: {
      "access-control-allow-origin": "*",
      // Changes only with a deploy, which purges the CDN; a few minutes of
      // staleness in a browser cache is harmless.
      "cache-control": "public, max-age=300, s-maxage=300",
      "x-robots-tag": "noindex",
    },
  });
}
