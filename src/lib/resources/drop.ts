import type { ResourceInput } from "./types";

/**
 * What a drag carried into Hubble, as resource inputs.
 *
 * ## Browsers do not agree, so nothing relies on one MIME type
 *
 * Measured, and summarized in docs/project-context.md:
 *
 *   - a link or the address-bar URL dragged out of Chrome/Edge:
 *     `text/uri-list` + `text/plain` (+ `text/html` with an anchor)
 *   - a tab dragged out of Firefox's tab strip — several, if several are
 *     selected: `text/x-moz-url` ("url\ntitle" pairs) + `text/uri-list`
 *   - Hubble's own extension side of a drag: `application/x-hubble-tabs`,
 *     JSON `[{url, title}]`
 *   - a selection of text: `text/plain`, possibly holding addresses
 *   - files (a downloaded PDF): `Files`
 *
 * Each format is read when present, richest first, and the results merged by
 * address — so a title from `x-moz-url` or an anchor's text is kept even when
 * `uri-list` (which has no titles) lists the same link.
 *
 * Chrome's own tab strip does not take part in HTML drag and drop at all:
 * dragging a tab there moves the tab between windows and never delivers data
 * to a page. That is a browser limitation, not something a page can change;
 * the extension's "Add to project" is the fallback for it.
 */

export const HUBBLE_TABS_MIME = "application/x-hubble-tabs";

export type DataTransferLike = {
  types: readonly string[] | DOMStringList;
  getData(type: string): string;
  files?: ArrayLike<File> | null;
};

export type DroppedResources = {
  inputs: ResourceInput[];
  files: File[];
  /** Something was dropped, but it held no address and no file. */
  empty: boolean;
};

const MAX_DROPPED = 200;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function typesOf(transfer: Pick<DataTransferLike, "types">): string[] {
  return Array.from(transfer.types as ArrayLike<string>);
}

/** Whether a drag in progress could be added to a project. Only types are readable before the drop. */
export function dragCarriesResources(transfer: Pick<DataTransferLike, "types"> | null | undefined): boolean {
  if (!transfer) return false;
  const types = typesOf(transfer);
  // Hubble's own tab rows (collections drag) are moves inside the app, not sources arriving.
  if (types.includes("application/x-tabdump-tab-id")) return false;
  return types.some(
    (type) => type === "Files" || type === "text/uri-list" || type === "text/x-moz-url" || type === HUBBLE_TABS_MIME || type === "text/plain"
  );
}

function safeGet(transfer: DataTransferLike, type: string): string {
  try {
    return transfer.getData(type) ?? "";
  } catch {
    return "";
  }
}

function trimTrailingPunctuation(url: string): string {
  return url.replace(/[),.;:!?\]]+$/, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "");
}

export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Firefox's `text/x-moz-url`: alternating address and title lines. */
export function parseMozUrl(text: string): ResourceInput[] {
  const lines = text.split(/\r?\n/);
  const out: ResourceInput[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const url = lines[index]?.trim();
    if (!url) continue;
    const title = lines[index + 1]?.trim();
    out.push({ url, ...(title && title !== url ? { title } : {}) });
  }
  return out;
}

export function parseHtmlAnchors(html: string): ResourceInput[] {
  const out: ResourceInput[] = [];
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const url = decodeEntities((match[1] ?? match[2] ?? "").trim());
    if (!url) continue;
    const title = decodeEntities(match[3]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ url, ...(title && title !== url ? { title } : {}) });
  }
  return out;
}

export function parseHubbleTabs(json: string): ResourceInput[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is { url: string; title?: unknown } => Boolean(entry) && typeof (entry as { url?: unknown }).url === "string")
      .map((entry) => ({ url: entry.url, ...(typeof entry.title === "string" && entry.title.trim() ? { title: entry.title.trim() } : {}) }));
  } catch {
    return [];
  }
}

export function urlsInText(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)].map((match) => trimTrailingPunctuation(match[0]));
}

export function readDroppedResources(transfer: DataTransferLike): DroppedResources {
  const types = typesOf(transfer);
  const byUrl = new Map<string, ResourceInput>();
  const add = (input: ResourceInput) => {
    const url = input.url.trim();
    if (!url) return;
    const existing = byUrl.get(url);
    if (!existing) byUrl.set(url, { ...input, url });
    else if (!existing.title && input.title) existing.title = input.title;
  };

  if (types.includes(HUBBLE_TABS_MIME)) parseHubbleTabs(safeGet(transfer, HUBBLE_TABS_MIME)).forEach(add);
  if (types.includes("text/x-moz-url")) parseMozUrl(safeGet(transfer, "text/x-moz-url")).forEach(add);
  if (types.includes("text/uri-list")) parseUriList(safeGet(transfer, "text/uri-list")).forEach((url) => add({ url }));
  if (types.includes("text/html")) {
    // Titles only for links already found above — a dragged page fragment can hold dozens of incidental links.
    const anchors = parseHtmlAnchors(safeGet(transfer, "text/html"));
    if (byUrl.size === 0 && anchors.length === 1) add(anchors[0]!);
    else for (const anchor of anchors) if (byUrl.has(anchor.url)) add(anchor);
  }
  if (byUrl.size === 0 && types.includes("text/plain")) {
    const plain = safeGet(transfer, "text/plain").trim();
    // A lone address without a scheme ("example.com/paper") is still an address when it is the whole text.
    const found = urlsInText(plain);
    if (found.length > 0) found.forEach((url) => add({ url }));
    else if (plain && !/\s/.test(plain) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(plain)) add({ url: plain });
  }

  const files = transfer.files ? Array.from(transfer.files) : [];
  const inputs = [...byUrl.values()].slice(0, MAX_DROPPED);
  return { inputs, files: files.slice(0, MAX_DROPPED), empty: inputs.length === 0 && files.length === 0 };
}
