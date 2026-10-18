import { decodeHtmlEntities } from "@/lib/resources/html";

/**
 * A Word document's text, without a Word library.
 *
 * A .docx is a zip archive; its body is the XML part `word/document.xml`.
 * This reads the archive's central directory, unpacks that one part with
 * the platform's own `DecompressionStream` (browsers, the desktop webview
 * and Node all have it), and keeps the words: paragraphs, line breaks, tabs
 * and table cells. Nothing in the document is executed or followed — macros,
 * links, embedded objects and fields are simply not read.
 *
 * Bounded twice: the part may not claim, or actually unpack to, more than
 * `maxBytes` — so a small file that inflates to gigabytes stops early.
 */

export class DocxUnreadableError extends Error {
  constructor(message = "This Word document couldn't be read.") {
    super(message);
    this.name = "DocxUnreadableError";
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

type ZipEntry = { name: string; method: number; flags: number; compressedSize: number; size: number; offset: number };

export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** An OLE compound file: an old .doc (or .xls), often renamed. */
export function isLegacyOfficeBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1;
}

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits in the last 22 bytes plus at most a 64 KB comment.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new DocxUnreadableError("This file is damaged or isn't a Word document.");
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  if (directory === 0xffffffff || count === 0xffff) throw new DocxUnreadableError("This Word document is too large to read.");
  const entries: ZipEntry[] = [];
  let at = directory;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) throw new DocxUnreadableError("This file is damaged or isn't a Word document.");
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new DocxUnreadableError("Word documents can't be read in this browser. Save it as PDF and add that.");
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DocxUnreadableError("This Word document is too large to read.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DocxUnreadableError) throw error;
    throw new DocxUnreadableError("This file is damaged or isn't a Word document.");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One part of a zip archive, unpacked. `undefined` when the archive has no such part. */
export async function readZipEntry(bytes: Uint8Array, name: string, maxBytes: number): Promise<Uint8Array | undefined> {
  const entry = zipEntries(bytes).find((candidate) => candidate.name === name);
  if (!entry) return undefined;
  if (entry.flags & 0x1) throw new DocxUnreadableError("This Word document is password-protected.");
  if (entry.size > maxBytes) throw new DocxUnreadableError("This Word document is too large to read.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL) throw new DocxUnreadableError("This file is damaged or isn't a Word document.");
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length < entry.compressedSize) throw new DocxUnreadableError("This file is damaged or isn't a Word document.");
  if (entry.method === 0) return data.slice();
  if (entry.method === 8) return inflateRaw(data, maxBytes);
  throw new DocxUnreadableError("This Word document uses a format Hubble can't read.");
}

/** Elements whose text is not the document's words: deleted revisions, field codes, and the like. */
const SKIPPED = new Set(["w:delText", "w:instrText", "w:delInstrText"]);

/** The words of `word/document.xml`, paragraph by paragraph. Pure. */
export function documentXmlText(xml: string): string {
  const out: string[] = [];
  let inText = false;
  // `<w:tabs>` lists a paragraph's tab stops (each a `<w:tab …/>`); only a `<w:tab/>` in a run is a tab character.
  let inTabStops = false;
  let cellDepth = 0;
  const pattern = /<(\/?)([A-Za-z][\w:.-]*)([^>]*)>|([^<]+)/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const [, closing, tag, rest, text] = match;
    if (text !== undefined) {
      if (inText) out.push(decodeHtmlEntities(text));
      continue;
    }
    const selfClosing = rest!.trimEnd().endsWith("/");
    if (tag === "w:t") {
      inText = !closing && !selfClosing;
      continue;
    }
    if (SKIPPED.has(tag!)) {
      inText = false;
      continue;
    }
    if (tag === "w:tabs") {
      inTabStops = !closing && !selfClosing;
      continue;
    }
    if (tag === "w:tc" && !selfClosing) {
      // A table cell's paragraphs stay on its row; cells are separated by tabs, rows by line breaks.
      cellDepth = Math.max(0, cellDepth + (closing ? -1 : 1));
      if (closing) out.push("\t");
      continue;
    }
    if (closing) {
      if (tag === "w:p") out.push(cellDepth > 0 ? " " : "\n\n");
      else if (tag === "w:tr") out.push("\n");
      else if (tag === "w:tbl") out.push("\n\n");
      continue;
    }
    if (tag === "w:tab" && !inTabStops) out.push("\t");
    else if (tag === "w:br" || tag === "w:cr") out.push("\n");
  }
  return out
    .join("")
    .replace(/ +\t/g, "\t")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractDocxText(bytes: Uint8Array, maxXmlBytes: number): Promise<string> {
  if (isLegacyOfficeBytes(bytes)) throw new DocxUnreadableError("This is an older Word file (.doc). Save it as .docx or PDF and add that.");
  if (!isZipBytes(bytes)) throw new DocxUnreadableError("This file is damaged or isn't a Word document.");
  const xml = await readZipEntry(bytes, "word/document.xml", maxXmlBytes);
  if (!xml) throw new DocxUnreadableError("This isn't a Word document.");
  return documentXmlText(new TextDecoder().decode(xml));
}
