import { RESOURCE_KINDS, RESOURCE_ORIGINS, RESOURCE_STATUSES } from "./types";
import type { ResourceError, ResourceErrorCode, ResourceMeta, TabResource } from "./types";

/**
 * A stored `resource`, re-read field by field.
 *
 * Local storage outlives the code that wrote it, and a hand-edited export
 * can hold anything. So nothing stored is trusted: an unknown kind or status
 * drops the record (the tab stays an ordinary tab, nothing is lost), unknown
 * fields are left behind, strings are bounded, and a source that was
 * "processing" when the page closed comes back as "pending" — the run that
 * was reading it no longer exists, and saying otherwise would be a spinner
 * that never ends.
 */

const ERROR_CODES: readonly ResourceErrorCode[] = [
  "unreachable",
  "blocked",
  "not_found",
  "too_large",
  "unsupported",
  "no_text",
  "pdf_needs_file",
  "pdf_unreadable",
  "transcript_unavailable",
  "timeout",
  "offline",
  "interrupted",
];

const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : undefined;

function readMeta(raw: unknown): ResourceMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const meta: ResourceMeta = {};
  for (const [field, max] of [
    ["mimeType", 120],
    ["siteName", 200],
    ["author", 200],
    ["publishedAt", 60],
    ["description", 500],
    ["fileName", 260],
  ] as const) {
    const value = text(source[field], max);
    if (value) meta[field] = value;
  }
  for (const field of ["pageCount", "durationSeconds", "fileSize"] as const) {
    const value = count(source[field]);
    if (value !== undefined) meta[field] = value;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function readError(raw: unknown): ResourceError | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  if (!ERROR_CODES.includes(source.code as ResourceErrorCode)) return undefined;
  const message = text(source.message, 300);
  if (!message) return undefined;
  return { code: source.code as ResourceErrorCode, message, retryable: source.retryable === true };
}

export function readTabResource(raw: unknown): TabResource | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (!RESOURCE_KINDS.includes(source.kind as TabResource["kind"])) return undefined;
  if (!RESOURCE_ORIGINS.includes(source.origin as TabResource["origin"])) return undefined;
  if (!RESOURCE_STATUSES.includes(source.status as TabResource["status"])) return undefined;
  const addedAt = time(source.addedAt);
  if (addedAt === undefined) return undefined;

  const status = source.status === "processing" ? "pending" : (source.status as TabResource["status"]);
  const meta = readMeta(source.meta);
  const error = status === "partial" || status === "failed" ? readError(source.error) : undefined;
  let content: TabResource["content"];
  if (source.content && typeof source.content === "object") {
    const summary = source.content as Record<string, unknown>;
    const chars = count(summary.chars);
    const extractedAt = time(summary.extractedAt);
    if (chars !== undefined && extractedAt !== undefined) {
      content = { chars, extractedAt };
      const pages = count(summary.pages);
      const lines = count(summary.transcriptLines);
      if (pages !== undefined) content.pages = pages;
      if (lines !== undefined) content.transcriptLines = lines;
      if (summary.truncated === true) content.truncated = true;
    }
  }
  // "Ready" is a claim that content exists; without a summary of it, it is not ready.
  const honestStatus = status === "ready" && !content ? "pending" : status;
  const attempts = count(source.attempts);

  return {
    kind: source.kind as TabResource["kind"],
    origin: source.origin as TabResource["origin"],
    status: honestStatus,
    addedAt,
    updatedAt: time(source.updatedAt) ?? addedAt,
    ...(meta ? { meta } : {}),
    ...(content ? { content } : {}),
    ...(error && (honestStatus === "partial" || honestStatus === "failed") ? { error } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
  };
}
