/**
 * Real PDF files, written byte by byte — so the reader tests open and draw
 * actual PDFs (a mathematics paper with equations, a graph and diagrams; a
 * plain text document; a scan that is only a picture) instead of mocks.
 * Offsets, lengths and the cross-reference table are computed, so any PDF
 * reader opens them.
 */

const encoder = new TextEncoder();

type PdfImage = { name: string; width: number; height: number; rgb: Uint8Array };

export type PdfPageSpec = {
  /** Page content stream operators. */
  content: string;
  /** Pictures the content draws, by name (`/Im1 Do`). */
  images?: readonly PdfImage[];
  width?: number;
  height?: number;
};

/** PDF string literal, escaped; characters above 0x7f are written as octal (WinAnsi), so "²" is \262. */
export function pdfString(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (code > 0x7e) out += `\\${(code & 0xff).toString(8).padStart(3, "0")}`;
    else out += char;
  }
  return `(${out})`;
}

/** `BT … ET` for one line of text at a point, in Helvetica (F1), bold (F2) or italic (F3). */
export function textAt(x: number, y: number, size: number, text: string, font: "F1" | "F2" | "F3" = "F1"): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET\n`;
}

function join(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function buildPdf(pages: readonly PdfPageSpec[]): Uint8Array<ArrayBuffer> {
  // Objects: 1 catalog, 2 page tree, 3-5 fonts, then per page [page, content, images…].
  const objects: Uint8Array[] = [];
  const add = (body: string | Uint8Array): number => {
    objects.push(typeof body === "string" ? encoder.encode(body) : body);
    return objects.length;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // the page tree, filled in once the pages exist
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  for (const page of pages) {
    const width = page.width ?? 612;
    const height = page.height ?? 792;
    const content = encoder.encode(page.content);
    const contentId = objects.length + 2;
    const imageIds = (page.images ?? []).map((_, index) => contentId + 1 + index);
    const xObjects = (page.images ?? []).map((image, index) => `/${image.name} ${imageIds[index]} 0 R`).join(" ");
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>${xObjects ? ` /XObject << ${xObjects} >>` : ""} >> >>`
      )
    );
    add(join([encoder.encode(`<< /Length ${content.length} >>\nstream\n`), content, encoder.encode("\nendstream")]));
    for (const image of page.images ?? []) {
      add(
        join([
          encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.rgb.length} >>\nstream\n`),
          image.rgb,
          encoder.encode("\nendstream"),
        ])
      );
    }
  }
  objects[1] = encoder.encode(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);

  const chunks: Uint8Array[] = [encoder.encode("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = join([encoder.encode(`${index + 1} 0 obj\n`), body, encoder.encode("\nendobj\n")]);
    chunks.push(object);
    length += object.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(encoder.encode(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return join(chunks);
}

/** A mathematics paper: three pages of questions with equations, a fraction, a square root, a graph, a triangle, a circle and answer boxes. */
export function mathExamPdf(): Uint8Array<ArrayBuffer> {
  const rule = (x1: number, y1: number, x2: number, y2: number) => `${x1} ${y1} m ${x2} ${y2} l S\n`;
  const box = (x: number, y: number, w: number, h: number) => `${x} ${y} ${w} ${h} re S\n`;

  const page1 =
    textAt(72, 720, 18, "Mathematics Paper 1", "F2") +
    textAt(72, 700, 11, "Time allowed: 90 minutes. Calculators are not permitted.", "F3") +
    textAt(72, 660, 12, "1.  Solve the quadratic equation", "F2") +
    textAt(110, 636, 14, "x² + 5x - 6 = 0") +
    textAt(450, 636, 10, "[3 marks]") +
    box(110, 560, 380, 50) +
    textAt(72, 520, 12, "2.  Simplify the expression", "F2") +
    textAt(130, 492, 12, "x² - 9") +
    rule(125, 486, 185, 486) +
    textAt(140, 472, 12, "x - 3") +
    textAt(450, 486, 10, "[2 marks]") +
    box(110, 400, 380, 50) +
    textAt(72, 360, 12, "3.  Evaluate the square root below.", "F2") +
    // radical sign: tick, descender, vinculum
    "110 322 m 116 316 l 124 332 l 160 332 l S\n" +
    textAt(130, 320, 14, "144") +
    textAt(450, 320, 10, "[1 mark]") +
    box(110, 250, 380, 40);

  const page2 =
    textAt(72, 720, 12, "4.  The graph of y = x² - 4 is drawn below.", "F2") +
    // axes
    rule(100, 450, 500, 450) +
    rule(300, 330, 300, 690) +
    // parabola y = x^2 - 4, drawn as a curve through (-3,5), (0,-4), (3,5)
    "0.8 0 0 RG 2 w 180 650 m 240 277 360 277 420 650 c S\n0 0 0 RG 1 w\n" +
    textAt(505, 446, 10, "x") +
    textAt(304, 692, 10, "y") +
    textAt(224, 436, 9, "-2") +
    textAt(366, 436, 9, "2") +
    textAt(305, 388, 9, "(0, -4)") +
    textAt(72, 300, 12, "(a)  Write down the coordinates of the turning point.") +
    box(110, 250, 380, 30) +
    textAt(72, 220, 12, "(b)  State the roots of the equation x² - 4 = 0.") +
    box(110, 170, 380, 30);

  const page3 =
    textAt(72, 720, 12, "5.  Triangle ABC is right-angled at B. AB = 3 cm and BC = 4 cm.", "F2") +
    // the triangle
    "150 520 m 150 640 l 310 520 l h S\n" +
    // right-angle marker
    "150 532 m 162 532 l 162 520 l S\n" +
    textAt(136, 512, 11, "B") +
    textAt(136, 644, 11, "A") +
    textAt(314, 512, 11, "C") +
    textAt(120, 580, 10, "3 cm") +
    textAt(215, 504, 10, "4 cm") +
    textAt(72, 470, 12, "Calculate the length of AC.") +
    box(110, 400, 380, 50) +
    textAt(72, 360, 12, "6.  A circle has radius r = 5 cm. Find its area, in terms of pi.", "F2") +
    // circle by four bezier arcs, radius 40 at (420, 300)
    "460 300 m 460 322 442 340 420 340 c 398 340 380 322 380 300 c 380 278 398 260 420 260 c 442 260 460 278 460 300 c S\n" +
    rule(420, 300, 460, 300) +
    textAt(432, 304, 9, "r") +
    textAt(110, 300, 12, "Area = ") +
    rule(160, 298, 330, 298);

  return buildPdf([{ content: page1 }, { content: page2 }, { content: page3 }]);
}

/** A plain text-based document: a few paragraphs over `pageTexts.length` pages. */
export function textPdf(pageTexts: readonly (readonly string[])[]): Uint8Array<ArrayBuffer> {
  return buildPdf(
    pageTexts.map((lines) => ({
      content: lines.map((line, index) => textAt(72, 720 - index * 20, 12, line)).join(""),
    }))
  );
}

/** A scan: every page is one picture (dark "lines of writing" on white) and has no text at all. */
export function scannedPdf(pageCount = 2): Uint8Array<ArrayBuffer> {
  const width = 120;
  const height = 160;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  for (let row = 20; row < height - 10; row += 14) {
    for (let y = row; y < row + 4; y++) {
      for (let x = 14; x < width - 14 - (row % 3) * 12; x++) {
        const at = (y * width + x) * 3;
        rgb[at] = rgb[at + 1] = rgb[at + 2] = 20;
      }
    }
  }
  const page = { content: "q 612 0 0 792 0 0 cm /Im1 Do Q\n", images: [{ name: "Im1", width, height, rgb }] } satisfies PdfPageSpec;
  return buildPdf(Array.from({ length: pageCount }, () => page));
}
