const GOOGLE_DOCS_HOSTNAMES = new Set(["docs.google.com", "drive.google.com"]);

/**
 * Shared by the server-side Google Docs resolver (which only runs there) and
 * the client-side title-resolution hook (which uses it to decide when a live
 * browser tab's title is worth checking) — kept in one place, in a module
 * with no "server-only" guard, so both sides agree on exactly which hosts
 * count as "a Google Docs URL" without duplicating the list.
 */
export function isGoogleDocsHostname(hostname: string): boolean {
  return GOOGLE_DOCS_HOSTNAMES.has(hostname.toLowerCase());
}

const DOC_SUFFIX = /\s*[-–]\s*Google (Docs|Sheets|Slides|Forms|Drawings)\s*$/i;

/**
 * Strips Chrome/Google's trailing "Document Name - Google Docs" (or
 * Sheets/Slides/Forms/Drawings) suffix, leaving just the document's own
 * name. Shared for the same reason as `isGoogleDocsHostname`: the
 * server-side resolver's scraped `<title>` and a browser extension's raw
 * `chrome.tabs.Tab.title` both carry this exact suffix and both need it
 * removed the same way, so a document titled literally "Google Docs" (no
 * suffix to strip) is left alone rather than emptied out.
 */
export function stripGoogleDocsSuffix(title: string): string {
  return title.replace(DOC_SUFFIX, "").trim();
}
