import "server-only";
import { detectResourceType, youtubeVideoId } from "@/lib/resources/detect";
import { EXTRACTION_ERRORS } from "@/lib/resources/extraction";
import { readHtml } from "@/lib/resources/html";
import { extractPdfText, isPdfBytes, PdfUnreadableError } from "@/lib/resources/pdf";
import { youtubeMomentUrl } from "@/lib/resources/youtube";
import { fetchBytes } from "./fetch";
import { configuredTranscriptProvider, getTranscript } from "./transcripts";
import type { TranscriptFetch, TranscriptProvider } from "./transcripts";
import type { ExtractionResponse } from "@/lib/resources/extraction";
import type { ResourceError, ResourceKind, ResourceMeta } from "@/lib/resources/types";

/**
 * Reads one source on the server: fetches it (safely, see ./fetch.ts),
 * decides what it really is from the response, and returns its readable
 * content — or an honest account of why there is none.
 */

export const EXTRACT_LIMITS = {
  /** A PDF up to this size is read; larger ones are saved without content. */
  pdfBytes: 15 * 1024 * 1024,
  /** HTML beyond this is not needed to find a page's text. */
  htmlBytes: 3 * 1024 * 1024,
  timeoutMs: 15_000,
  /** Less readable text than this means the page is a script-rendered shell or a gate, not an article. */
  minReadableChars: 280,
} as const;

type Fetcher = typeof fetchBytes;

function fileNameOf(url: string): string | undefined {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return last && last.includes(".") ? last.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

const SIGN_IN_HOST = /^(?:accounts|login|signin|auth|sso)\./i;
const SIGN_IN_PATH = /\/(?:signin|sign-in|sign_in|login|log-in|logon|servicelogin)(?:\/|$)/i;

function isSignInAddress(url: URL): boolean {
  return SIGN_IN_HOST.test(url.hostname) || SIGN_IN_PATH.test(url.pathname);
}

/**
 * Whether asking for `requested` was answered by a redirect to a sign-in
 * page: the source exists, but only for someone signed in. Asking for a
 * sign-in page itself is not that.
 */
export function landedOnSignIn(requested: string, final: string): boolean {
  try {
    const asked = new URL(requested);
    const landed = new URL(final);
    if (asked.href === landed.href || isSignInAddress(asked)) return false;
    return isSignInAddress(landed);
  } catch {
    return false;
  }
}

/** What a YouTube read may do about captions; the route decides (a configured provider, and the caller's allowance). */
export type TranscriptOptions = {
  provider: TranscriptProvider | null;
  /** The reader's preferred language; the provider falls back to the video's own. */
  language?: string;
  /** False once this caller has used its transcript allowance: the video is still saved, without asking. */
  allowed?: boolean;
};

function transcriptError(reason: Extract<TranscriptFetch, { ok: false }>["reason"], videoGone: boolean): ResourceError {
  if (videoGone || reason === "not_found") return EXTRACTION_ERRORS.video_unavailable;
  if (reason === "not_configured") return EXTRACTION_ERRORS.transcripts_off;
  if (reason === "no_captions") return EXTRACTION_ERRORS.transcript_unavailable;
  if (reason === "timeout") return EXTRACTION_ERRORS.transcript_timeout;
  if (reason === "malformed") return EXTRACTION_ERRORS.transcript_failed;
  return EXTRACTION_ERRORS.transcript_busy;
}

/**
 * A YouTube video: its public metadata from oEmbed and, when this server
 * has a transcript provider, its existing captions (server/transcripts.ts)
 * — asked at the same time, so a video costs one round trip.
 *
 * Ready only with a transcript in hand. Without one the video is still a
 * source — saved, playable, searchable by title — and says why.
 */
async function youtube(url: string, fetcher: Fetcher, transcripts: TranscriptOptions): Promise<ExtractionResponse> {
  const id = youtubeVideoId(url)!;
  const watch = youtubeMomentUrl(id);
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`;
  const [fetched, transcript] = await Promise.all([
    fetcher(oembed, { accept: "application/json", maxBytes: 64 * 1024, timeoutMs: 8_000 }),
    transcripts.allowed === false
      ? Promise.resolve<TranscriptFetch>({ ok: false, reason: "rate_limited" })
      : getTranscript(id, { provider: transcripts.provider, ...(transcripts.language ? { language: transcripts.language } : {}) }),
  ]);

  const meta: ResourceMeta = { siteName: "YouTube" };
  let title: string | undefined;
  // 400 (an id that resolves to nothing — what oEmbed answers in practice) and 404 are "no such video";
  // 401/403 are private or embedding turned off — the video may still have captions.
  const videoGone = fetched.ok && (fetched.status === 400 || fetched.status === 404);
  if (fetched.ok && fetched.status === 200) {
    let data: { title?: unknown; author_name?: unknown } = {};
    try {
      data = JSON.parse(new TextDecoder().decode(fetched.bytes)) as typeof data;
    } catch {
      data = {};
    }
    if (typeof data.author_name === "string" && data.author_name.trim()) meta.author = data.author_name.trim().slice(0, 200);
    if (typeof data.title === "string" && data.title.trim()) title = data.title.trim().slice(0, 300);
  }

  if (transcript.ok) {
    return {
      ok: true,
      kind: "youtube",
      status: "ready",
      finalUrl: watch,
      ...(title ? { title } : {}),
      meta,
      content: {
        transcript: transcript.segments,
        transcriptInfo: { source: "captions", provider: transcript.provider, ...(transcript.language ? { language: transcript.language } : {}) },
      },
    };
  }
  // Neither answered: nothing was learned, so it is a failure to retry, not a saved video without a transcript.
  if (!fetched.ok && transcript.reason !== "no_captions" && transcript.reason !== "not_found") {
    return { ok: false, error: fetched.reason === "timeout" ? EXTRACTION_ERRORS.timeout : EXTRACTION_ERRORS.unreachable };
  }
  return { ok: true, kind: "youtube", status: "partial", finalUrl: watch, ...(title ? { title } : {}), meta, error: transcriptError(transcript.reason, videoGone) };
}

export async function extractSource(
  url: string,
  options: { kind?: ResourceKind; fetcher?: Fetcher; transcripts?: TranscriptOptions } = {}
): Promise<ExtractionResponse> {
  const fetcher = options.fetcher ?? fetchBytes;
  const expected = options.kind ?? detectResourceType({ url });
  if (expected === "youtube" && youtubeVideoId(url)) return youtube(url, fetcher, options.transcripts ?? { provider: configuredTranscriptProvider() });

  const fetched = await fetcher(url, {
    accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    maxBytes: EXTRACT_LIMITS.pdfBytes,
    timeoutMs: EXTRACT_LIMITS.timeoutMs,
  });
  if (!fetched.ok) {
    if (fetched.reason === "unsafe") return { ok: false, error: { code: "blocked", message: "Hubble doesn't read addresses on private networks.", retryable: false } };
    return { ok: false, error: fetched.reason === "timeout" ? EXTRACTION_ERRORS.timeout : EXTRACTION_ERRORS.unreachable };
  }

  const mimeType = fetched.contentType.split(";")[0]!.trim().toLowerCase();
  const meta: ResourceMeta = mimeType ? { mimeType } : {};
  const finalUrl = fetched.finalUrl;
  const pdf = mimeType === "application/pdf" || isPdfBytes(fetched.bytes);
  const kind: ResourceKind = pdf ? "pdf" : detectResourceType({ url: finalUrl, ...(mimeType ? { mimeType } : {}) });
  const partial = (error: ResourceError, title?: string, as: ResourceKind = kind): ExtractionResponse => ({
    ok: true,
    kind: as,
    status: "partial",
    finalUrl,
    ...(title ? { title } : {}),
    meta,
    error,
  });

  if (fetched.status === 404 || fetched.status === 410) return partial(EXTRACTION_ERRORS.not_found);
  if (fetched.status === 401 || fetched.status === 403 || fetched.status === 429 || fetched.status >= 500) {
    if (expected === "pdf") return partial(EXTRACTION_ERRORS.pdf_needs_file, undefined, "pdf");
    if (fetched.status === 401) return partial(EXTRACTION_ERRORS.sign_in);
    return partial(fetched.status >= 500 || fetched.status === 429 ? { ...EXTRACTION_ERRORS.unreachable, message: "The site didn't answer. Try again later." } : EXTRACTION_ERRORS.blocked);
  }

  if (pdf) {
    if (fetched.truncated) return partial(EXTRACTION_ERRORS.too_large);
    meta.fileSize = fetched.bytes.byteLength;
    const fileName = fileNameOf(finalUrl);
    if (fileName) meta.fileName = fileName;
    try {
      const text = await extractPdfText(fetched.bytes);
      meta.pageCount = text.pageCount;
      if (text.author) meta.author = text.author;
      const title = text.title ?? fileName;
      if (text.pages.every((page) => page.length === 0)) {
        return partial({ code: "no_text", message: "PDF saved. It has no text layer — it may be a scan.", retryable: false }, title);
      }
      return { ok: true, kind: "pdf", status: "ready", finalUrl, ...(title ? { title } : {}), meta, content: { pages: text.pages } };
    } catch (error) {
      return partial(error instanceof PdfUnreadableError ? { ...EXTRACTION_ERRORS.pdf_unreadable, message: `PDF saved. ${error.message}` } : EXTRACTION_ERRORS.pdf_unreadable, fileName);
    }
  }

  // Expected a PDF and got a page: a login wall or a viewer page in front of the file.
  if (expected === "pdf") return partial(EXTRACTION_ERRORS.pdf_needs_file, undefined, "pdf");

  // Sent to a sign-in page (Google Drive, Microsoft 365, Notion…): its text is a login form, not the source.
  if (landedOnSignIn(url, finalUrl)) return partial(EXTRACTION_ERRORS.sign_in);

  if (mimeType === "text/html" || mimeType === "application/xhtml+xml" || mimeType === "") {
    const html = new TextDecoder().decode(fetched.bytes.subarray(0, EXTRACT_LIMITS.htmlBytes));
    const page = readHtml(html);
    if (page.siteName) meta.siteName = page.siteName;
    if (page.author) meta.author = page.author;
    if (page.publishedAt) meta.publishedAt = page.publishedAt;
    if (page.description) meta.description = page.description;
    if (page.text.length < EXTRACT_LIMITS.minReadableChars) return partial(EXTRACTION_ERRORS.no_text, page.title);
    return { ok: true, kind: kind === "youtube" ? "webpage" : kind, status: "ready", finalUrl, ...(page.title ? { title: page.title } : {}), meta, content: { text: page.text } };
  }

  if (/^text\/(plain|markdown|csv)$/.test(mimeType)) {
    const text = new TextDecoder().decode(fetched.bytes.subarray(0, EXTRACT_LIMITS.htmlBytes)).trim();
    const fileName = fileNameOf(finalUrl);
    if (!text) return partial(EXTRACTION_ERRORS.no_text, fileName);
    return { ok: true, kind: "document", status: "ready", finalUrl, ...(fileName ? { title: fileName } : {}), meta, content: { text } };
  }

  return partial(EXTRACTION_ERRORS.unsupported, fileNameOf(finalUrl));
}
