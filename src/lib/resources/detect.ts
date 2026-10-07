import type { ResourceKind } from "./types";

/**
 * What kind of thing a source is, from everything Hubble knows about it
 * before (or after) reading it: the address, and a MIME type when a surface
 * or the server reported one.
 *
 * Order of evidence, strongest first:
 *
 *   1. a MIME type — the server's Content-Type, or a dropped file's type —
 *      because a URL can lie (`/download?id=7` is a PDF; `/paper.pdf` can be
 *      an HTML landing page that only links to one);
 *   2. known providers by hostname and path (YouTube watch/shorts/embed/live,
 *      youtu.be; Vimeo and other video hosts);
 *   3. the path's extension;
 *   4. otherwise a web page — the honest default for an http(s) address.
 *
 * `unknown` is reserved for an address that is not http(s) at all.
 */

const PDF_MIME = /^application\/(x-)?pdf\b/i;
const HTML_MIME = /^(text\/html|application\/xhtml\+xml)\b/i;
const VIDEO_MIME = /^video\//i;
const DOCUMENT_MIME =
  /^(text\/plain|text\/markdown|text\/csv|application\/rtf|application\/msword|application\/vnd\.openxmlformats-officedocument\.|application\/vnd\.oasis\.opendocument\.)/i;

const VIDEO_HOSTS = new Set(["vimeo.com", "player.vimeo.com", "dailymotion.com", "twitch.tv", "loom.com", "ted.com"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "mkv", "avi"]);
const DOCUMENT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "rtf", "doc", "docx", "odt", "epub"]);

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^(www|m)\./, "");
}

/** A YouTube video id from any of its address shapes, or `undefined`. */
export function youtubeVideoId(input: string | URL): string | undefined {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return undefined;
  }
  const host = hostOf(url);
  const valid = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined);
  if (host === "youtu.be") return valid(url.pathname.split("/")[1]);
  if (host !== "youtube.com" && host !== "music.youtube.com" && host !== "youtube-nocookie.com") return undefined;
  if (url.pathname === "/watch") return valid(url.searchParams.get("v"));
  const [, first, second] = url.pathname.split("/");
  if (first === "shorts" || first === "embed" || first === "live" || first === "v") return valid(second);
  return undefined;
}

function extensionOf(url: URL): string | undefined {
  const last = url.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return undefined;
  try {
    return decodeURIComponent(last.slice(dot + 1)).toLowerCase();
  } catch {
    return last.slice(dot + 1).toLowerCase();
  }
}

export function detectResourceType(input: { url: string; mimeType?: string; fileName?: string }): ResourceKind {
  const mime = input.mimeType?.trim();
  let url: URL | undefined;
  try {
    url = new URL(input.url);
  } catch {
    url = undefined;
  }
  const web = url && (url.protocol === "http:" || url.protocol === "https:");

  if (mime) {
    if (PDF_MIME.test(mime)) return "pdf";
    // A video page served as HTML is still the provider's video.
    if (HTML_MIME.test(mime)) return url && web && youtubeVideoId(url) ? "youtube" : "webpage";
    if (VIDEO_MIME.test(mime)) return "video";
    if (DOCUMENT_MIME.test(mime)) return "document";
  }

  const fileExtension = input.fileName?.split(".").pop()?.toLowerCase();
  if (fileExtension === "pdf") return "pdf";

  if (!url || !web) return fileExtension && DOCUMENT_EXTENSIONS.has(fileExtension) ? "document" : "unknown";

  if (youtubeVideoId(url)) return "youtube";
  const host = hostOf(url);
  if (VIDEO_HOSTS.has(host) && url.pathname.length > 1) return "video";

  const extension = extensionOf(url);
  if (extension === "pdf") return "pdf";
  // arXiv serves PDFs under /pdf/<id> with no extension.
  if (host === "arxiv.org" && url.pathname.startsWith("/pdf/")) return "pdf";
  if (extension && VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension && DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return "webpage";
}
