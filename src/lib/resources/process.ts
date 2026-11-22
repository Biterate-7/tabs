import { publicApiUrl } from "@/lib/platform/api-base";
import { CONVERSATION_NEEDS_CAPTURE, EXTRACTION_ERRORS, isExtractionResponse } from "./extraction";
import { extractPdfText, PdfUnreadableError } from "./pdf";
import { cleanLanguageTag, normalizeTranscript, parseTranscript } from "./transcript";
import { youtubeVideoId } from "./detect";
import { youtubeMomentUrl } from "./youtube";
import type { ExtractionRequest, ExtractionResponse } from "./extraction";
import type { BrowserTranscript, BrowserTranscriptFailure, BrowserTranscriptRequest } from "./youtube-browser";
import type { Tab } from "@/lib/tabs/types";
import type { ResourceContent, ResourceContentSummary, ResourceError, ResourceMeta, TabResource } from "./types";

/**
 * Reading a source, from the browser's side.
 *
 * `processSource` takes one pending source and returns what its tab should
 * now say — status, metadata, a content summary, an error in words — after
 * the content itself has been written to the content store. Content first,
 * then the claim: a tab never says "ready" for content that was not saved.
 *
 * The extraction service and the store are passed in, so the whole state
 * machine is tested without a network or IndexedDB.
 */

export const MAX_AUTOMATIC_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;

export type ProcessDeps = {
  extract: (request: ExtractionRequest) => Promise<ExtractionResponse>;
  putContent: (workspaceId: string, tabId: string, content: ResourceContent) => Promise<ResourceContentSummary>;
  now: () => number;
  /** The reader's preferred transcript language — the browser's, when it says. */
  language?: () => string | undefined;
  /**
   * A YouTube video's transcript from YouTube's own page, through Hubble for
   * Chrome (youtube-browser.ts) — asked when the reader had none.
   */
  readTranscript?: (request: BrowserTranscriptRequest) => Promise<BrowserTranscript>;
};

/** A source added or retried this recently was the person's own doing: reading it may wake Chrome's extension. */
export const RECENT_ACTION_MS = 2 * 60_000;

/** The browser's language, as a hint for which captions to prefer. */
export function browserLanguage(): string | undefined {
  return typeof navigator === "undefined" ? undefined : cleanLanguageTag(navigator.language);
}

/**
 * What the reader sent, made safe to store: a transcript is cleaned and
 * re-ordered here too (the desktop app reads a deployment it did not ship
 * with), and one that comes back empty is no transcript at all.
 */
function receivedContent(content: NonNullable<Extract<ExtractionResponse, { ok: true }>["content"]>): typeof content | undefined {
  if (!content.transcript) return content;
  const transcript = normalizeTranscript(content.transcript);
  if (transcript.length === 0) {
    if (!content.text && !content.pages) return undefined;
    const rest = { ...content };
    delete rest.transcript;
    delete rest.transcriptInfo;
    return rest;
  }
  const language = cleanLanguageTag(content.transcriptInfo?.language);
  const provider = typeof content.transcriptInfo?.provider === "string" ? content.transcriptInfo.provider.slice(0, 40) : undefined;
  return {
    ...content,
    transcript,
    transcriptInfo: { source: "captions", ...(language ? { language } : {}), ...(provider ? { provider } : {}) },
  };
}

export type ProcessResult = {
  tabId: string;
  resource: TabResource;
  /** A better title than the tab has — only when it had none of its own. */
  title?: string;
};

/** Where the reader lives: same origin on the web; the deployed site from the desktop app, which has no server of its own. */
export function extractionEndpoint(platform: "web" | "desktop"): string {
  return publicApiUrl("/api/resources/extract", platform);
}

export function httpExtractor(endpoint: string): ProcessDeps["extract"] {
  return async (request) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, error: EXTRACTION_ERRORS.offline };
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        // text/plain keeps the request CORS-simple for the desktop app (no preflight).
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data: unknown = await response.json().catch(() => null);
      if (isExtractionResponse(data)) return data;
      return { ok: false, error: response.status === 429 ? { ...EXTRACTION_ERRORS.unreachable, message: "Too many at once — try again in a minute." } : EXTRACTION_ERRORS.offline };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? EXTRACTION_ERRORS.timeout : EXTRACTION_ERRORS.offline };
    }
  };
}

/** What a video says when Hubble for Chrome couldn't read its transcript from YouTube. */
export function browserTranscriptError(reason: BrowserTranscriptFailure): ResourceError {
  switch (reason) {
    case "no_transcript":
      return EXTRACTION_ERRORS.transcript_unavailable;
    case "video_unavailable":
      return EXTRACTION_ERRORS.video_unavailable;
    case "no_access":
      return EXTRACTION_ERRORS.transcript_needs_access;
    case "no_extension":
      return EXTRACTION_ERRORS.transcript_needs_extension;
    case "no_answer":
      return EXTRACTION_ERRORS.transcript_extension_asleep;
    case "outdated":
      return EXTRACTION_ERRORS.transcript_extension_outdated;
    case "not_loaded":
    case "timeout":
      return EXTRACTION_ERRORS.transcript_timeout;
    default:
      return EXTRACTION_ERRORS.transcript_read_failed;
  }
}

/**
 * Whether a video's reading still lacks a transcript worth asking YouTube's
 * page for. Not when the reader brought one, and not for a video its reader
 * found gone (oEmbed's "no such video"): there is nothing to open.
 */
function wantsPageTranscript(response: ExtractionResponse): boolean {
  return !(response.ok && (response.status === "ready" || response.error?.code === "not_found"));
}

/**
 * A video's reading, completed by its transcript from YouTube's page: the
 * reader (the deployed site) knows its title and channel; the page knows what
 * is said. Without a transcript the video is still saved, and says why — unless
 * neither could tell anything, which is a failure to retry.
 */
export function withPageTranscript(response: ExtractionResponse, page: BrowserTranscript, videoId: string): ExtractionResponse {
  const site = response.ok ? response : undefined;
  const finalUrl = site?.finalUrl ?? youtubeMomentUrl(videoId);
  if (page.ok) {
    const meta: ResourceMeta = { siteName: "YouTube", ...site?.meta };
    if (!meta.author && page.channel) meta.author = page.channel;
    const title = site?.title ?? page.title;
    return {
      ok: true,
      kind: "youtube",
      status: "ready",
      finalUrl,
      ...(title ? { title } : {}),
      meta,
      content: { transcript: page.segments, transcriptInfo: { source: "captions", provider: "youtube" } },
    };
  }
  const error = browserTranscriptError(page.reason);
  if (site) return { ...site, status: "partial", error };
  if (page.reason === "no_transcript" || page.reason === "video_unavailable") {
    return { ok: true, kind: "youtube", status: "partial", finalUrl, meta: { siteName: "YouTube" }, error };
  }
  return response;
}

/** A title worth replacing: none, or just the address/domain shown in its place. */
function needsTitle(tab: Pick<Tab, "title" | "url" | "domain">): boolean {
  const title = tab.title?.trim();
  return !title || title === tab.url || title === tab.domain;
}

function mergeMeta(current: ResourceMeta | undefined, next: ResourceMeta | undefined): ResourceMeta | undefined {
  const merged = { ...current, ...next };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function settle(resource: TabResource, patch: Partial<TabResource>, now: number): TabResource {
  const next: TabResource = { ...resource, ...patch, updatedAt: now };
  if (next.status === "ready") delete next.error;
  return next;
}

export async function processSource(workspaceId: string, tab: Tab, deps: ProcessDeps): Promise<ProcessResult> {
  const resource = tab.resource!;
  const failed = (error: ResourceError): ProcessResult => ({ tabId: tab.id, resource: settle(resource, { status: "failed", error }, deps.now()) });

  // An AI conversation is never fetched by address (it is behind the person's sign-in): it is a link until its text is saved.
  if (resource.kind === "conversation") {
    return resource.content
      ? { tabId: tab.id, resource: settle(resource, { status: "ready" }, deps.now()) }
      : { tabId: tab.id, resource: settle(resource, { status: "partial", error: CONVERSATION_NEEDS_CAPTURE }, deps.now()) };
  }

  let response: ExtractionResponse;
  try {
    const language = resource.kind === "youtube" ? deps.language?.() : undefined;
    response = await deps.extract({ url: tab.url, kind: resource.kind, ...(language ? { language } : {}) });
  } catch {
    response = { ok: false, error: EXTRACTION_ERRORS.offline };
  }
  // A video's transcript, when the reader had none, from YouTube's own page in Chrome.
  const videoId = resource.kind === "youtube" && deps.readTranscript ? youtubeVideoId(tab.url) : undefined;
  if (videoId && deps.readTranscript && wantsPageTranscript(response)) {
    const wake = deps.now() - resource.updatedAt < RECENT_ACTION_MS;
    let page: BrowserTranscript;
    try {
      page = await deps.readTranscript({ videoId, wake });
    } catch {
      page = { ok: false, reason: "failed" };
    }
    response = withPageTranscript(response, page, videoId);
  }
  if (!response.ok) return failed(response.error);

  const meta = mergeMeta(resource.meta, response.meta);
  const title = response.title && needsTitle(tab) ? response.title : undefined;
  const base = { kind: response.kind, ...(meta ? { meta } : {}) };

  const received = response.status === "ready" && response.content ? receivedContent(response.content) : undefined;
  if (received) {
    const content: ResourceContent = { kind: response.kind, ...received, extractedAt: deps.now() };
    let summary: ResourceContentSummary;
    try {
      summary = await deps.putContent(workspaceId, tab.id, content);
    } catch {
      return failed({ code: "interrupted", message: "Hubble read this but couldn't save its text on this device.", retryable: true });
    }
    return { tabId: tab.id, resource: settle(resource, { ...base, status: "ready", content: summary }, deps.now()), ...(title ? { title } : {}) };
  }

  // Content a person attached earlier (an uploaded PDF, a transcript) survives a re-read that found none.
  if (resource.content) {
    return { tabId: tab.id, resource: settle(resource, { ...base, status: "ready" }, deps.now()), ...(title ? { title } : {}) };
  }
  const error = response.error ?? (response.kind === "youtube" ? EXTRACTION_ERRORS.transcript_unavailable : EXTRACTION_ERRORS.no_text);
  return { tabId: tab.id, resource: settle(resource, { ...base, status: "partial", error }, deps.now()), ...(title ? { title } : {}) };
}

/**
 * A PDF the person supplied for a source — read in this browser, so the file
 * never leaves the device. Replaces whatever the source had.
 */
export async function attachPdfFile(
  workspaceId: string,
  tab: Tab,
  file: Blob & { name?: string },
  deps: Pick<ProcessDeps, "putContent" | "now">
): Promise<ProcessResult> {
  const resource = tab.resource!;
  const meta: ResourceMeta = { ...resource.meta, mimeType: "application/pdf", fileSize: file.size, ...(file.name ? { fileName: file.name.slice(0, 260) } : {}) };
  try {
    const text = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
    meta.pageCount = text.pageCount;
    if (text.author) meta.author = text.author;
    if (text.pages.every((page) => page.length === 0)) {
      return { tabId: tab.id, resource: settle(resource, { kind: "pdf", meta, status: "partial", error: { code: "no_text", message: "PDF saved. It has no text layer — it may be a scan.", retryable: false } }, deps.now()) };
    }
    const summary = await deps.putContent(workspaceId, tab.id, { kind: "pdf", pages: text.pages, extractedAt: deps.now() });
    const title = text.title && needsTitle(tab) ? text.title : undefined;
    return { tabId: tab.id, resource: settle(resource, { kind: "pdf", meta, status: "ready", content: summary, origin: resource.origin }, deps.now()), ...(title ? { title } : {}) };
  } catch (error) {
    const message = error instanceof PdfUnreadableError ? `PDF saved. ${error.message}` : EXTRACTION_ERRORS.pdf_unreadable.message;
    return { tabId: tab.id, resource: settle(resource, { kind: "pdf", meta, status: "partial", error: { code: "pdf_unreadable", message, retryable: true } }, deps.now()) };
  }
}

/** A transcript the person supplied for a video source — pasted, or a caption file. */
export async function attachTranscript(
  workspaceId: string,
  tab: Tab,
  text: string,
  deps: Pick<ProcessDeps, "putContent" | "now">
): Promise<ProcessResult | { error: string }> {
  const lines = parseTranscript(text);
  if (lines.length === 0) return { error: "That doesn't look like a transcript — paste the text or choose a .vtt, .srt or .txt file." };
  const resource = tab.resource!;
  const summary = await deps.putContent(workspaceId, tab.id, { kind: resource.kind, transcript: lines, transcriptInfo: { source: "supplied" }, extractedAt: deps.now() });
  return { tabId: tab.id, resource: settle(resource, { status: "ready", content: summary }, deps.now()) };
}

/** Whether Hubble should pick this source up on its own: new, or interrupted, and not retried to exhaustion. */
export function shouldProcess(resource: TabResource | undefined): boolean {
  return resource?.status === "pending" && (resource.attempts ?? 0) < MAX_AUTOMATIC_ATTEMPTS;
}

/**
 * The claim that Hubble is reading a source now. The attempt is counted here,
 * when it starts — so a source that crashes the page every time it is read
 * still runs out of automatic attempts across reloads.
 */
export function markProcessing(resource: TabResource, now: number): TabResource {
  return { ...resource, status: "processing", updatedAt: now, attempts: (resource.attempts ?? 0) + 1 };
}

/** Back to pending, so the processor reads it again. What Retry does. */
export function requeue(resource: TabResource, now: number): TabResource {
  const next: TabResource = { ...resource, status: "pending", updatedAt: now, attempts: 0 };
  delete next.error;
  return next;
}
