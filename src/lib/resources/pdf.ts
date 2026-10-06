/**
 * A PDF's text, page by page — on the server for a PDF Hubble fetched, and
 * in the browser for one the person uploaded (which therefore never leaves
 * their device).
 *
 * Built on unpdf (a serverless build of Mozilla's pdf.js), imported on demand
 * so the parser is only ever loaded when a PDF is actually read.
 */

export type PdfText = {
  pages: string[];
  pageCount: number;
  title?: string;
  author?: string;
};

export class PdfUnreadableError extends Error {
  constructor(message = "This PDF couldn't be read.") {
    super(message);
    this.name = "PdfUnreadableError";
  }
}

function clean(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  // "%PDF-" within the first kilobyte, as readers accept.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  if (!isPdfBytes(bytes)) throw new PdfUnreadableError("This file isn't a PDF.");
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy: pdf.js transfers (detaches) the buffer it is given.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    const message = error instanceof Error && /password/i.test(error.message) ? "This PDF is password-protected." : "This PDF couldn't be read.";
    throw new PdfUnreadableError(message);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  let info: Record<string, unknown> = {};
  try {
    info = ((await getMeta(pdf)).info ?? {}) as Record<string, unknown>;
  } catch {
    info = {};
  }
  const title = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim().slice(0, 300) : undefined;
  const author = typeof info.Author === "string" && info.Author.trim() ? info.Author.trim().slice(0, 200) : undefined;
  return {
    pages: (Array.isArray(text) ? text : [String(text)]).map(clean),
    pageCount: totalPages,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
  };
}
