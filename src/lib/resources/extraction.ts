import type { ResourceContent, ResourceError, ResourceKind, ResourceMeta } from "./types";

/**
 * The wire contract between `/api/resources/extract` and the browser.
 *
 * One source per request: sources are processed independently, so one slow
 * PDF never holds up the web pages dropped with it, and a failure is always
 * that source's own.
 *
 * `status` is the server's honest reading of what it got:
 *   ready    readable content is in `content`
 *   partial  the source exists and has metadata, but no readable content
 *            (`error` says why — a PDF behind a login, a video with no
 *            transcript Hubble may fetch, a page with no text)
 * A source the server could not reach at all is `{ ok: false }`.
 */

export type ExtractionRequest = { url: string; kind?: ResourceKind };

export type ExtractionResponse =
  | {
      ok: true;
      kind: ResourceKind;
      status: "ready" | "partial";
      /** Where the content actually came from, after redirects. */
      finalUrl: string;
      title?: string;
      meta: ResourceMeta;
      content?: Omit<ResourceContent, "extractedAt" | "kind">;
      error?: ResourceError;
    }
  | { ok: false; error: ResourceError };

export const EXTRACTION_ERRORS = {
  unreachable: { code: "unreachable", message: "Hubble couldn't reach this page.", retryable: true },
  blocked: { code: "blocked", message: "The site refused to let Hubble read this page.", retryable: false },
  not_found: { code: "not_found", message: "The page no longer exists at this address.", retryable: false },
  too_large: { code: "too_large", message: "This file is too large for Hubble to read.", retryable: false },
  unsupported: { code: "unsupported", message: "Hubble can't read this kind of file yet. The address is saved.", retryable: false },
  no_text: { code: "no_text", message: "Source saved, but Hubble couldn't find readable text on the page.", retryable: true },
  pdf_needs_file: { code: "pdf_needs_file", message: "PDF detected. Hubble needs the file itself to read its contents.", retryable: true },
  pdf_unreadable: { code: "pdf_unreadable", message: "PDF saved. Text extraction failed.", retryable: true },
  transcript_unavailable: {
    code: "transcript_unavailable",
    message: "Video saved. Transcript isn't available — add one to let agents read what's said.",
    retryable: false,
  },
  timeout: { code: "timeout", message: "The page took too long to respond.", retryable: true },
  offline: { code: "offline", message: "Hubble couldn't reach its reader. Check your connection.", retryable: true },
  interrupted: { code: "interrupted", message: "Reading was interrupted.", retryable: true },
} as const satisfies Record<string, ResourceError>;

export function isExtractionResponse(value: unknown): value is ExtractionResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.ok === false) return Boolean(record.error && typeof record.error === "object");
  return record.ok === true && typeof record.kind === "string" && (record.status === "ready" || record.status === "partial") && typeof record.finalUrl === "string";
}
