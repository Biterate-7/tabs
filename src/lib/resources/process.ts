import { apiOrigin } from "@/lib/platform/api-base";
import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs";
import { EXTRACTION_ERRORS, isExtractionResponse } from "./extraction";
import { extractPdfText, PdfUnreadableError } from "./pdf";
import { parseTranscript } from "./transcript";
import type { ExtractionRequest, ExtractionResponse } from "./extraction";
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
};

export type ProcessResult = {
  tabId: string;
  resource: TabResource;
  /** A better title than the tab has — only when it had none of its own. */
  title?: string;
};

/** Where the reader lives: same origin on the web; the deployed site from the desktop app, which has no server of its own. */
export function extractionEndpoint(platform: "web" | "desktop"): string {
  return `${apiOrigin() || (platform === "desktop" ? CANONICAL_PRODUCTION_ORIGIN : "")}/api/resources/extract`;
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
      return { ok: false, error: response.status === 429 ? { ...EXTRACTION_ERRORS.unreachable, message: "Too many sources read at once — try again in a minute." } : EXTRACTION_ERRORS.offline };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? EXTRACTION_ERRORS.timeout : EXTRACTION_ERRORS.offline };
    }
  };
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

  let response: ExtractionResponse;
  try {
    response = await deps.extract({ url: tab.url, kind: resource.kind });
  } catch {
    return failed(EXTRACTION_ERRORS.offline);
  }
  if (!response.ok) return failed(response.error);

  const meta = mergeMeta(resource.meta, response.meta);
  const title = response.title && needsTitle(tab) ? response.title : undefined;
  const base = { kind: response.kind, ...(meta ? { meta } : {}) };

  if (response.status === "ready" && response.content) {
    const content: ResourceContent = { kind: response.kind, ...response.content, extractedAt: deps.now() };
    let summary: ResourceContentSummary;
    try {
      summary = await deps.putContent(workspaceId, tab.id, content);
    } catch {
      return failed({ code: "interrupted", message: "Hubble read this source but couldn't save its text on this device.", retryable: true });
    }
    return { tabId: tab.id, resource: settle(resource, { ...base, status: "ready", content: summary }, deps.now()), ...(title ? { title } : {}) };
  }

  // Content a person attached earlier (an uploaded PDF, a transcript) survives a re-read that found none.
  if (resource.content) {
    return { tabId: tab.id, resource: settle(resource, { ...base, status: "ready" }, deps.now()), ...(title ? { title } : {}) };
  }
  const error = response.error ?? EXTRACTION_ERRORS.no_text;
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

/** A transcript the person supplied for a video source (see transcript.ts for why Hubble never fetches one). */
export async function attachTranscript(
  workspaceId: string,
  tab: Tab,
  text: string,
  deps: Pick<ProcessDeps, "putContent" | "now">
): Promise<ProcessResult | { error: string }> {
  const lines = parseTranscript(text);
  if (lines.length === 0) return { error: "That doesn't look like a transcript — paste the text or choose a .vtt, .srt or .txt file." };
  const resource = tab.resource!;
  const summary = await deps.putContent(workspaceId, tab.id, { kind: resource.kind, transcript: lines, extractedAt: deps.now() });
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
