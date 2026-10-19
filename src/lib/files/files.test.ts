// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { makeTestPdf } from "@/lib/resources/__fixtures__/pdf";
import { makeDocx, makeZip, p } from "./__fixtures__/docx";
import { documentXmlText, extractDocxText, DocxUnreadableError } from "./docx";
import { extractFile } from "./extract";
import { bytesHash, checkFile, cleanFileName, detectFileFormat, FILE_INPUT_ACCEPT, FILE_LIMITS, titleFromFileName } from "./formats";
import { canRereadFile, composeFileNote, readFileNote, restartFileRead, startFileRead } from "./note";
import { decodeTextFile, NotTextError } from "./text";

const NOW = Date.UTC(2026, 9, 18, 12);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("which files can be added", () => {
  it("knows a format by its extension first, then by its type", () => {
    expect(detectFileFormat({ name: "Lecture 4.PDF" })).toBe("pdf");
    expect(detectFileFormat({ name: "essay.docx" })).toBe("docx");
    expect(detectFileFormat({ name: "notes.md" })).toBe("markdown");
    expect(detectFileFormat({ name: "data.tsv" })).toBe("csv");
    expect(detectFileFormat({ name: "download", type: "application/pdf" })).toBe("pdf");
    expect(detectFileFormat({ name: "page", type: "text/html; charset=utf-8" })).toBe("html");
    // A known extension Hubble can't read is not rescued by a vague type.
    expect(detectFileFormat({ name: "old.doc", type: "text/plain" })).toBeUndefined();
    expect(detectFileFormat({ name: "photo.png", type: "image/png" })).toBeUndefined();
  });

  it("refuses unsupported, empty and oversized files with what to do instead", () => {
    expect(checkFile({ name: "old.doc", size: 10 })).toMatchObject({ ok: false, code: "unsupported", message: expect.stringContaining(".docx or PDF") });
    expect(checkFile({ name: "photo.png", size: 10, type: "image/png" })).toMatchObject({ ok: false, code: "unsupported" });
    expect(checkFile({ name: "empty.txt", size: 0 })).toMatchObject({ ok: false, code: "empty" });
    expect(checkFile({ name: "book.pdf", size: FILE_LIMITS.maxBytes + 1 })).toMatchObject({ ok: false, code: "too_large", message: expect.stringContaining("25 MB") });
    expect(checkFile({ name: "huge.txt", size: FILE_LIMITS.maxTextBytes + 1 })).toMatchObject({ ok: false, code: "too_large" });
    expect(checkFile({ name: "paper.pdf", size: 2_000_000 })).toEqual({ ok: true, format: "pdf" });
  });

  it("offers the same files in every platform's picker", () => {
    for (const accepted of [".pdf", ".docx", ".md", ".txt", "application/pdf"]) expect(FILE_INPUT_ACCEPT.split(",")).toContain(accepted);
  });

  it("keeps a file name, never a path or characters that disguise it", () => {
    expect(cleanFileName("C:\\Users\\me\\Desktop\\notes.md")).toBe("notes.md");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    // A right-to-left override would show "invoice‮fdp.exe" as "invoiceexe.pdf".
    expect(cleanFileName("invoice\u202Efdp.exe")).not.toContain("\u202E");
    expect(cleanFileName("   ")).toBe("Untitled file");
    expect(titleFromFileName("Lecture 4 - Thermodynamics.pdf")).toBe("Lecture 4 - Thermodynamics");
    expect(titleFromFileName(".bashrc")).toBe(".bashrc");
  });

  it("fingerprints bytes, so the same file is recognised and a different one is not", () => {
    expect(bytesHash(utf8("one"))).toMatch(/^[0-9a-f]{16}$/);
    expect(bytesHash(utf8("one"))).toBe(bytesHash(utf8("one")));
    expect(bytesHash(utf8("one"))).not.toBe(bytesHash(utf8("onf")));
  });
});

describe("reading text files", () => {
  it("reads UTF-8, UTF-16 with a byte-order mark, and older Windows text", () => {
    expect(decodeTextFile(utf8("café\r\nnaïve"))).toBe("café\nnaïve");
    expect(decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("bom")]))).toBe("bom");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(decodeTextFile(utf16)).toBe("hi");
    // "café" as Windows-1252: é is 0xE9, not valid UTF-8 on its own.
    expect(decodeTextFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
  });

  it("refuses a binary file renamed .txt", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0]);
    expect(() => decodeTextFile(png)).toThrow(NotTextError);
  });
});

describe("reading Word documents", () => {
  it("keeps paragraphs, line breaks, tabs, tables and entities — and leaves out deleted text and field codes", async () => {
    const body = [
      p("Causes of the First World War"),
      `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Militarism</w:t><w:tab/><w:t>Alliances &amp; empires</w:t><w:br/><w:t>second line</w:t></w:r></w:p>`,
      `<w:p><w:r><w:delText>removed in review</w:delText></w:r><w:r><w:instrText> HYPERLINK "https://x" </w:instrText></w:r><w:r><w:t>kept</w:t></w:r></w:p>`,
      `<w:tbl><w:tr><w:tc>${p("Year")}</w:tc><w:tc>${p("Event")}</w:tc></w:tr><w:tr><w:tc>${p("1914")}</w:tc><w:tc>${p("Sarajevo")}</w:tc></w:tr></w:tbl>`,
      p("The end."),
    ].join("");
    const text = await extractDocxText(makeDocx(body), FILE_LIMITS.maxDocxXmlBytes);
    expect(text).toBe("Causes of the First World War\n\nMilitarism\tAlliances & empires\nsecond line\n\nkept\n\nYear\tEvent\n1914\tSarajevo\n\nThe end.");
    expect(text).not.toMatch(/removed in review|HYPERLINK/);
  });

  it("reads a document stored without compression too", async () => {
    expect(await extractDocxText(makeDocx(p("stored"), { store: true }), 1_000_000)).toBe("stored");
  });

  it("refuses old .doc files, damaged archives, zips that aren't documents, and encrypted parts — each with a reason", async () => {
    const legacy = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(extractDocxText(legacy, 1_000_000)).rejects.toThrow(/older Word file/);
    const docx = makeDocx(p("hello"));
    await expect(extractDocxText(docx.slice(0, docx.length - 30), 1_000_000)).rejects.toThrow(DocxUnreadableError);
    await expect(extractDocxText(makeZip([{ name: "readme.txt", data: "not word" }]), 1_000_000)).rejects.toThrow("This isn't a Word document.");
    await expect(extractDocxText(makeZip([{ name: "word/document.xml", data: "<x/>", encrypted: true }]), 1_000_000)).rejects.toThrow(/password-protected/);
    await expect(extractDocxText(utf8("plain text named .docx"), 1_000_000)).rejects.toThrow(DocxUnreadableError);
  });

  it("stops a small file that unpacks to far more than it claims", async () => {
    // 2 MB of zeros compresses to a few KB; the part lies about its size, and the inflater stops at the limit anyway.
    const bomb = makeZip([{ name: "word/document.xml", data: new Uint8Array(2_000_000), claimedSize: 100 }]);
    expect(bomb.length).toBeLessThan(20_000);
    await expect(extractDocxText(bomb, 500_000)).rejects.toThrow(/too large/);
    // And one that admits its size is refused before inflating at all.
    await expect(extractDocxText(makeZip([{ name: "word/document.xml", data: new Uint8Array(600_000) }]), 500_000)).rejects.toThrow(/too large/);
  });

  it("turns the document XML into words without executing or following anything", () => {
    expect(documentXmlText(`<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>`)).toBe("<script>alert(1)</script>");
  });
});

describe("extractFile — every outcome honest", () => {
  it("reads a multi-page PDF page by page, so answers can cite pages", async () => {
    const result = await extractFile(makeTestPdf(["Entropy always increases.", "Heat flows from hot to cold.", "The third law."]), "pdf", NOW);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.pageCount).toBe(3);
    expect(result.content).toMatchObject({ kind: "pdf", extractedAt: NOW });
    expect(result.content.pages).toEqual(["Entropy always increases.", "Heat flows from hot to cold.", "The third law."]);
  });

  it("never calls a scanned PDF ready — it is kept, and says it has no text", async () => {
    const result = await extractFile(makeTestPdf(["", " "]), "pdf", NOW);
    expect(result).toMatchObject({ status: "partial", pageCount: 2, error: { code: "no_text", message: expect.stringContaining("scan") } });
  });

  it("refuses a file that only looks like a PDF, and a damaged one", async () => {
    expect(await extractFile(utf8("<html>login</html>"), "pdf", NOW)).toMatchObject({ status: "failed", error: { message: "This file isn't a PDF." } });
    const broken = await extractFile(utf8("%PDF-1.4\n garbage without objects"), "pdf", NOW);
    expect(broken.status).toBe("failed");
  });

  it("reads Word, Markdown, text and HTML as one text", async () => {
    expect(await extractFile(makeDocx(p("From a Word file")), "docx", NOW)).toMatchObject({ status: "ready", content: { kind: "document", text: "From a Word file" } });
    expect(await extractFile(utf8("# Notes\n\n- entropy\n"), "markdown", NOW)).toMatchObject({ status: "ready", content: { text: "# Notes\n\n- entropy" } });
    const html = await extractFile(utf8("<html><head><script>steal()</script></head><body><article><p>Readable paragraph about thermodynamics and heat engines.</p></article></body></html>"), "html", NOW);
    expect(html).toMatchObject({ status: "ready" });
    if (html.status === "ready") expect(html.content.text).not.toContain("steal()");
  });

  it("keeps a file with nothing to read as saved-without-text, and refuses binary content", async () => {
    expect(await extractFile(utf8("   \n\n  "), "text", NOW)).toMatchObject({ status: "partial", error: { code: "no_text" } });
    expect(await extractFile(makeDocx(p("")), "docx", NOW)).toMatchObject({ status: "partial", error: { message: "This document has no text." } });
    expect(await extractFile(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2]), "text", NOW)).toMatchObject({ status: "failed", error: { code: "unsupported" } });
  });
});

describe("an uploaded file as a project note", () => {
  const note = composeFileNote({ id: "n1", name: "C:\\fakepath\\Lecture 4.pdf", format: "pdf", size: 1234, hash: "0123456789abcdef", now: NOW });

  it("is added as Reading…, titled from its name, with no text claimed", () => {
    expect(note).toMatchObject({ id: "n1", kind: "file", title: "Lecture 4", origin: "upload", chars: 0, file: { name: "Lecture 4.pdf", format: "pdf", size: 1234, status: "processing", attempts: 1 } });
  });

  it("stores the text before it claims to be ready", async () => {
    const order: string[] = [];
    const putContent = vi.fn(async (_workspace: string, _id: string, content: { pages?: string[] }) => {
      order.push("stored");
      return { chars: content.pages!.join("").length, pages: content.pages!.length, extractedAt: NOW };
    });
    const result = await readFileNote("w", note, makeTestPdf(["First page.", "Second page."]), { putContent, now: () => NOW });
    order.push("claimed");
    expect(order).toEqual(["stored", "claimed"]);
    expect(putContent).toHaveBeenCalledWith("w", "n1", expect.objectContaining({ kind: "pdf", pages: ["First page.", "Second page."] }));
    expect(result).toEqual({ file: { name: "Lecture 4.pdf", format: "pdf", size: 1234, status: "ready", attempts: 1, pages: 2 }, chars: 23 });
  });

  it("says it failed — and can be tried again — when the text couldn't be kept on the device", async () => {
    const result = await readFileNote("w", note, makeTestPdf(["Text."]), { putContent: async () => Promise.reject(new Error("QuotaExceededError")), now: () => NOW });
    expect(result.chars).toBe(0);
    expect(result.file).toMatchObject({ status: "failed", error: { retryable: true } });
    expect(canRereadFile(result.file)).toBe(true);
  });

  it("never stores anything for a scan, and a scan is not offered Try again", async () => {
    const putContent = vi.fn();
    const result = await readFileNote("w", note, makeTestPdf([""]), { putContent, now: () => NOW });
    expect(putContent).not.toHaveBeenCalled();
    expect(result.file).toMatchObject({ status: "partial", pages: 1 });
    expect(canRereadFile(result.file)).toBe(false);
  });

  it("counts readings as they start, and Read again starts the count over", () => {
    const failed = { ...note.file!, status: "failed" as const, attempts: 3, error: { code: "interrupted" as const, message: "x", retryable: true } };
    expect(startFileRead(failed)).toMatchObject({ status: "processing", attempts: 4 });
    expect(startFileRead(failed).error).toBeUndefined();
    expect(restartFileRead(failed)).toMatchObject({ status: "processing", attempts: 1 });
  });
});
