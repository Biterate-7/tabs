import { cleanLine } from "@/lib/conversations/clean";

/**
 * Files a person can add to a project, and how Hubble tells them apart.
 *
 * An uploaded file is read **in the browser** (or the desktop webview):
 * nothing is sent to a server to be read, and the original bytes stay on
 * this device next to the text Hubble extracted (lib/resources/content-store).
 *
 * The format is decided by the file's name and type first, then confirmed
 * from its bytes when it is read (extract.ts) — a `.pdf` that isn't one, or a
 * legacy `.doc` renamed `.docx`, is refused there with a reason, never
 * "ready".
 */

export type FileFormat = "pdf" | "docx" | "markdown" | "text" | "csv" | "json" | "html";

export const FILE_FORMATS: readonly FileFormat[] = ["pdf", "docx", "markdown", "text", "csv", "json", "html"] as const;

type FormatSpec = { label: string; extensions: readonly string[]; mimeTypes: readonly string[] };

const SPECS: Record<FileFormat, FormatSpec> = {
  pdf: { label: "PDF", extensions: ["pdf"], mimeTypes: ["application/pdf", "application/x-pdf"] },
  docx: { label: "Word document", extensions: ["docx"], mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  markdown: { label: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"], mimeTypes: ["text/markdown", "text/x-markdown"] },
  text: { label: "Text", extensions: ["txt", "text", "log", "rst", "tex"], mimeTypes: ["text/plain"] },
  csv: { label: "CSV", extensions: ["csv", "tsv"], mimeTypes: ["text/csv", "text/tab-separated-values"] },
  json: { label: "JSON", extensions: ["json"], mimeTypes: ["application/json"] },
  html: { label: "HTML", extensions: ["html", "htm"], mimeTypes: ["text/html"] },
};

export const FILE_FORMAT_LABEL: Record<FileFormat, string> = Object.fromEntries(FILE_FORMATS.map((format) => [format, SPECS[format].label])) as Record<FileFormat, string>;

/** The MIME type a stored original is given back with. */
export const FILE_FORMAT_MIME: Record<FileFormat, string> = {
  pdf: "application/pdf",
  docx: SPECS.docx.mimeTypes[0]!,
  markdown: "text/markdown",
  text: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/plain",
};

export const FILE_LIMITS = {
  /** One file: a long scanned book is bigger, a long paper or report is far smaller. */
  maxBytes: 25 * 1024 * 1024,
  /** Text formats are read whole into memory; this many bytes is ~10 million characters. */
  maxTextBytes: 10 * 1024 * 1024,
  /** A DOCX's document part, unpacked. Stops a small zip that unpacks to gigabytes. */
  maxDocxXmlBytes: 40 * 1024 * 1024,
  /** Files chosen in one go. */
  perUpload: 20,
  name: 255,
} as const;

/** For `<input type="file" accept>`: extensions and types, so every platform's picker offers the same files. */
export const FILE_INPUT_ACCEPT = FILE_FORMATS.flatMap((format) => [...SPECS[format].extensions.map((extension) => `.${extension}`), ...SPECS[format].mimeTypes]).join(",");

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The format a file says it is: its extension, else its MIME type. `undefined` when Hubble can't read it. */
export function detectFileFormat(file: { name: string; type?: string }): FileFormat | undefined {
  const extension = extensionOf(file.name);
  if (extension) {
    const byExtension = FILE_FORMATS.find((format) => SPECS[format].extensions.includes(extension));
    if (byExtension) return byExtension;
    // A known extension Hubble can't read wins over a vague type (a .doc sent as application/octet-stream).
    if (UNSUPPORTED_HINT[extension]) return undefined;
  }
  const type = (file.type ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type) return undefined;
  return FILE_FORMATS.find((format) => SPECS[format].mimeTypes.includes(type));
}

/** What to do instead, for files people commonly try. */
const UNSUPPORTED_HINT: Record<string, string> = {
  doc: "Older Word files (.doc) can't be read. Save it as .docx or PDF and add that.",
  rtf: "Rich text (.rtf) can't be read. Save it as .docx, PDF or text and add that.",
  pages: "Pages files can't be read. Export it as PDF or Word and add that.",
  odt: "OpenDocument files can't be read yet. Save it as .docx or PDF and add that.",
  ppt: "Presentations can't be read yet. Export it as PDF and add that.",
  pptx: "Presentations can't be read yet. Export it as PDF and add that.",
  xls: "Spreadsheets can't be read yet. Save it as CSV and add that.",
  xlsx: "Spreadsheets can't be read yet. Save it as CSV and add that.",
  epub: "E-books can't be read yet. Add a PDF instead.",
  zip: "Zip files can't be added. Add the files inside it instead.",
};

export type FileCheck =
  | { ok: true; format: FileFormat }
  | { ok: false; code: "unsupported" | "too_large" | "empty"; message: string };

/** Whether a chosen file can be added, before any of it is read. */
export function checkFile(file: { name: string; size: number; type?: string }): FileCheck {
  const format = detectFileFormat(file);
  if (!format) {
    const hint = UNSUPPORTED_HINT[extensionOf(file.name)];
    return { ok: false, code: "unsupported", message: hint ?? "This kind of file can't be read. Add a PDF, Word (.docx), Markdown or text file." };
  }
  if (file.size === 0) return { ok: false, code: "empty", message: "This file is empty." };
  const max = format === "pdf" || format === "docx" ? FILE_LIMITS.maxBytes : FILE_LIMITS.maxTextBytes;
  if (file.size > max) return { ok: false, code: "too_large", message: `This file is too large to add (${formatBytes(file.size)}). The limit is ${formatBytes(max)}.` };
  return { ok: true, format };
}

/**
 * A file name safe to keep and show: no folders, no control or bidi
 * characters (which can make "exe.pdf" read as "fdp.exe"), bounded.
 */
export function cleanFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  const cleaned = cleanLine(base, FILE_LIMITS.name);
  return cleaned || "Untitled file";
}

/** A title for the item: the file's name without its extension. */
export function titleFromFileName(name: string): string {
  const clean = cleanFileName(name);
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot).trim() : clean;
  return stem || clean;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * A fingerprint of a file's bytes, in the same 16-hex shape as a note's
 * content hash: the same file added twice to one project is recognised.
 * Two independent FNV-1a passes. Equality, not secrecy.
 */
export function bytesHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9 ^ bytes.length;
  for (let index = 0; index < bytes.length; index++) {
    const code = bytes[index]!;
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
