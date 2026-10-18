import { readHtml } from "@/lib/resources/html";
import { extractPdfText, isPdfBytes, PdfUnreadableError } from "@/lib/resources/pdf";
import { DocxUnreadableError, extractDocxText } from "./docx";
import { FILE_LIMITS } from "./formats";
import { decodeTextFile, NotTextError } from "./text";
import type { FileFormat } from "./formats";
import type { ResourceContent, ResourceError } from "@/lib/resources/types";

/**
 * What Hubble could read from one uploaded file — in this browser, from the
 * bytes the person chose.
 *
 *   ready    text was found: PDFs page by page (so an answer can cite
 *            "p. 4"), everything else as one text
 *   partial  the file is fine and kept, but has no text to read — a scanned
 *            PDF (Hubble does no OCR), an empty document
 *   failed   the file can't be read: damaged, password-protected, or not
 *            what its name says
 *
 * Every outcome is honest: nothing is "ready" without text, and a file that
 * merely looks like a PDF is not read as one. Extracted text is untrusted
 * data — stored and quoted, never followed.
 */

export type FileExtraction =
  | { status: "ready"; content: ResourceContent; pageCount?: number; title?: string; author?: string }
  | { status: "partial"; error: ResourceError; pageCount?: number }
  | { status: "failed"; error: ResourceError };

const failed = (message: string, retryable = false): FileExtraction => ({ status: "failed", error: { code: "pdf_unreadable", message, retryable } });

export const FILE_ERRORS = {
  scan: { code: "no_text", message: "No text found — this PDF may be a scan. Hubble can't read scanned pages.", retryable: false },
  emptyDocument: { code: "no_text", message: "This document has no text.", retryable: false },
  emptyFile: { code: "no_text", message: "This file has no text.", retryable: false },
  notPdf: { code: "unsupported", message: "This file isn't a PDF.", retryable: false },
  notText: { code: "unsupported", message: "This file doesn't contain readable text.", retryable: false },
  unexpected: { code: "pdf_unreadable", message: "Something went wrong reading this file. Try again.", retryable: true },
} as const satisfies Record<string, ResourceError>;

function hasText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export async function extractFile(bytes: Uint8Array, format: FileFormat, now: number): Promise<FileExtraction> {
  try {
    if (format === "pdf") {
      if (!isPdfBytes(bytes)) return { status: "failed", error: FILE_ERRORS.notPdf };
      const pdf = await extractPdfText(bytes);
      if (!pdf.pages.some(hasText)) return { status: "partial", error: FILE_ERRORS.scan, pageCount: pdf.pageCount };
      return {
        status: "ready",
        content: { kind: "pdf", pages: pdf.pages, extractedAt: now },
        pageCount: pdf.pageCount,
        ...(pdf.title ? { title: pdf.title } : {}),
        ...(pdf.author ? { author: pdf.author } : {}),
      };
    }
    if (format === "docx") {
      const text = await extractDocxText(bytes, FILE_LIMITS.maxDocxXmlBytes);
      if (!hasText(text)) return { status: "partial", error: FILE_ERRORS.emptyDocument };
      return { status: "ready", content: { kind: "document", text, extractedAt: now } };
    }
    const decoded = decodeTextFile(bytes);
    const text = format === "html" ? readHtml(decoded).text : decoded.trim();
    if (!hasText(text)) return { status: "partial", error: FILE_ERRORS.emptyFile };
    return { status: "ready", content: { kind: "document", text, extractedAt: now } };
  } catch (error) {
    if (error instanceof PdfUnreadableError || error instanceof DocxUnreadableError) return failed(error.message);
    if (error instanceof NotTextError) return { status: "failed", error: FILE_ERRORS.notText };
    // Not the file's fault as far as Hubble can tell (out of memory, a parser crash): worth another try.
    return { status: "failed", error: FILE_ERRORS.unexpected };
  }
}
