/**
 * Project sources (Hubble 2.0): what a project knows, collected from the
 * browser.
 *
 * ## Not a second model
 *
 * A source is a `Tab` — the record Hubble has always kept for a saved web
 * page — that carries a `resource` describing it as project material: what
 * kind of thing it is, how it arrived, and whether Hubble could read it. Every
 * surface that already understands tabs (collections, the graph, sync, the
 * Context Bridge, the session's MCP tools) keeps working on sources unchanged,
 * and an existing tab becomes a source by gaining the field, nothing else.
 *
 *     Tab ─────────────── id · url · title · domain · notes …   (unchanged)
 *      └── resource ───── kind · origin · status · meta · content summary · error
 *
 * ## What is stored where
 *
 * The tab holds only small, describable facts. What Hubble extracted — page
 * text, PDF pages, a transcript — can run to hundreds of kilobytes, so it
 * lives in IndexedDB (`content-store.ts`), keyed by account, project and tab,
 * and is loaded only when something reads it. `resource.content` says what is
 * there (how many characters, pages, transcript lines) without holding it.
 *
 * ## Honest status
 *
 *   pending     added; Hubble has not looked at it yet
 *   processing  Hubble is reading it now
 *   ready       Hubble holds readable content an agent can use
 *   partial     saved, but only its address and metadata are usable
 *               (a PDF Hubble could not fetch, a video with no transcript)
 *   failed      Hubble could not process it at all — retryable unless said
 *
 * Nothing is ever "ready" without content in the store, and nothing stays
 * "processing" across a reload: an interrupted run goes back to pending.
 */

export type ResourceKind = "webpage" | "pdf" | "youtube" | "video" | "document" | "unknown";

export const RESOURCE_KINDS: readonly ResourceKind[] = ["webpage", "pdf", "youtube", "video", "document", "unknown"] as const;

export type ResourceStatus = "pending" | "processing" | "ready" | "partial" | "failed";

export const RESOURCE_STATUSES: readonly ResourceStatus[] = ["pending", "processing", "ready", "partial", "failed"] as const;

/** How a source reached the project. Distinct from `Tab.source`, which says whether a tab came from open tabs or history. */
export type ResourceOrigin = "chrome" | "extension" | "manual" | "upload" | "import";

export const RESOURCE_ORIGINS: readonly ResourceOrigin[] = ["chrome", "extension", "manual", "upload", "import"] as const;

export type ResourceMeta = {
  mimeType?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  description?: string;
  pageCount?: number;
  durationSeconds?: number;
  /** An uploaded file's own name. */
  fileName?: string;
  fileSize?: number;
};

/** What the content store holds for a source — counts, never the content. */
export type ResourceContentSummary = {
  /** Characters of readable text (page text, all PDF pages, or the transcript). */
  chars: number;
  /** PDF pages with text. */
  pages?: number;
  /** Transcript lines. */
  transcriptLines?: number;
  /** Cut to the storage bound. */
  truncated?: boolean;
  extractedAt: number;
};

export type ResourceErrorCode =
  | "unreachable"
  | "blocked"
  | "not_found"
  | "too_large"
  | "unsupported"
  | "no_text"
  | "pdf_needs_file"
  | "pdf_unreadable"
  | "transcript_unavailable"
  | "timeout"
  | "offline"
  | "interrupted";

export type ResourceError = {
  code: ResourceErrorCode;
  message: string;
  retryable: boolean;
};

export type TabResource = {
  kind: ResourceKind;
  origin: ResourceOrigin;
  status: ResourceStatus;
  addedAt: number;
  updatedAt: number;
  meta?: ResourceMeta;
  content?: ResourceContentSummary;
  /** Why the status is `partial` or `failed`. */
  error?: ResourceError;
  /** Processing runs so far; bounds automatic retries. */
  attempts?: number;
};

/** One thing to add to a project, from any surface: a drop, the extension, the Add source dialog, an existing tab. */
export type ResourceInput = {
  url: string;
  title?: string;
  /** A MIME type the surface knew (a dropped file, a download). */
  mimeType?: string;
  favicon?: string;
};

/** Extracted content, as the content store keeps it. */
export type ResourceContent = {
  kind: ResourceKind;
  /** Readable text of a web page or document. */
  text?: string;
  /** A PDF's text, page by page — index 0 is page 1. */
  pages?: string[];
  /** A video transcript, line by line, with a start time in seconds when known. */
  transcript?: { start?: number; text: string }[];
  extractedAt: number;
  truncated?: boolean;
};

/** Storage bounds, per source. Large enough for a long paper; small enough that 100 sources stay usable. */
export const CONTENT_LIMITS = {
  text: 400_000,
  pages: 2_000,
  pageText: 40_000,
  transcriptLines: 20_000,
  transcriptLine: 2_000,
} as const;

export const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = {
  webpage: "Web page",
  pdf: "PDF",
  youtube: "YouTube video",
  video: "Video",
  document: "Document",
  unknown: "Link",
};

export const RESOURCE_STATUS_LABEL: Record<ResourceStatus, string> = {
  pending: "Waiting",
  processing: "Reading…",
  ready: "Ready",
  partial: "Saved",
  failed: "Couldn't read",
};
