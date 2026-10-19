import type { PdfPageSize, PdfView } from "../pdf-view";

/**
 * A PdfView that records what the reader asked of it, with a text layer made
 * of each page's text — the way pdf.js lays a page's words over its picture.
 * The reader's own behaviour (which pages it paints, zoom, search marks) is
 * tested against this, without a canvas or a worker; real drawing is tested
 * in pdf-render.test.ts.
 */
export type FakePdfView = PdfView & {
  painted: { page: number; scale: number }[];
  texted: number[];
  released: number[];
  destroyed: () => boolean;
};

export function fakePdfView(pageTexts: readonly string[], size: PdfPageSize = { width: 612, height: 792 }): FakePdfView {
  let destroyed = false;
  const view: FakePdfView = {
    pageCount: pageTexts.length,
    painted: [],
    texted: [],
    released: [],
    destroyed: () => destroyed,
    async page(number) {
      if (number < 1 || number > pageTexts.length) throw new Error("no such page");
      return {
        size,
        paint(canvas, scale, pixelRatio) {
          view.painted.push({ page: number, scale });
          canvas.width = Math.round(size.width * scale * pixelRatio);
          canvas.height = Math.round(size.height * scale * pixelRatio);
          return { done: Promise.resolve(), cancel: () => undefined };
        },
        layText(container) {
          view.texted.push(number);
          const span = container.ownerDocument.createElement("span");
          span.textContent = pageTexts[number - 1]!;
          container.append(span);
          return { done: Promise.resolve(), cancel: () => undefined };
        },
        release: () => void view.released.push(number),
      };
    },
    async destroy() {
      destroyed = true;
    },
  };
  return view;
}
