/**
 * Drawing an uploaded PDF as the PDF it is — the other half of reading one.
 *
 * Reading (lib/resources/pdf) takes a PDF's *text* so it can be searched and
 * quoted to an AI. Showing it takes the same original bytes and paints each
 * page, so layout, equations, diagrams and scans look as their author made
 * them. Neither replaces the other: this module never produces text for
 * search or AI, and the reader never styles extracted text to look like a page.
 *
 * Everything runs in the browser (or the desktop webview) on bytes already
 * kept on this device; nothing is fetched except pdf.js's own font, colour
 * and decoder data, which Hubble serves itself from /pdfjs (see
 * scripts/copy-pdfjs-assets.mjs). pdf.js is imported on demand, and parses
 * in a worker so a heavy page never freezes the app.
 *
 * The component talks to the small `PdfView` interface below, not to pdf.js,
 * so the reader is tested without a canvas or a worker.
 */

/** A page's size in CSS pixels at 100% (1 PDF point = 1 px), after its own rotation. */
export type PdfPageSize = { width: number; height: number };

/** Something running that can be stopped when the page scrolls away. */
export type PdfTask = { done: Promise<void>; cancel: () => void };

export type PdfPageView = {
  size: PdfPageSize;
  /** Paints the page onto `canvas`, which is sized here: `scale` CSS px per PDF point, `pixelRatio` device px per CSS px. */
  paint: (canvas: HTMLCanvasElement, scale: number, pixelRatio: number) => PdfTask;
  /** Lays the page's invisible, selectable text over the picture, so it can be selected, found and highlighted. */
  layText: (container: HTMLElement, scale: number) => PdfTask;
  /** Lets go of what was loaded for the page. */
  release: () => void;
};

export type PdfView = {
  pageCount: number;
  page: (number: number) => Promise<PdfPageView>;
  destroy: () => Promise<void>;
};

export type PdfViewFailure = "password" | "damaged" | "failed";

export class PdfViewError extends Error {
  readonly reason: PdfViewFailure;
  constructor(reason: PdfViewFailure, message: string) {
    super(message);
    this.name = "PdfViewError";
    this.reason = reason;
  }
}

export const PDF_VIEW_MESSAGES: Record<PdfViewFailure, string> = {
  password: "This PDF is password-protected, so Hubble can't show it.",
  damaged: "This PDF is damaged and can't be shown.",
  failed: "Hubble couldn't show this PDF.",
};

/** Where Hubble serves pdf.js's data files from (copied into public/ by scripts/copy-pdfjs-assets.mjs). */
export const PDFJS_ASSET_BASE = "/pdfjs/";

/** The most pixels one page canvas may hold: past this, browsers drop the canvas or run out of memory. */
export const MAX_CANVAS_PIXELS = 16_000_000;

/** The device-pixel ratio to paint a page at: sharp on dense screens, never beyond what a canvas can hold. */
export function paintRatio(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  const wanted = Math.min(Math.max(devicePixelRatio || 1, 1), 2);
  const allowed = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssWidth * cssHeight));
  return Math.max(0.25, Math.min(wanted, allowed));
}

type PdfJs = typeof import("pdfjs-dist");

let pdfjs: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import("pdfjs-dist").then((module) => {
    if (!module.GlobalWorkerOptions.workerPort) {
      // A bundled, same-origin module worker: no CDN, and allowed by the desktop app's content security policy.
      module.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    }
    return module;
  });
  // A failed load (offline chunk, blocked worker) must not stick for the rest of the session.
  pdfjs.catch(() => {
    pdfjs = undefined;
  });
  return pdfjs;
}

/** Documents being closed: pdf.js refuses to open another on its worker until they are (a reader closed and reopened at once). */
let closing: Promise<unknown> = Promise.resolve();

function classify(error: unknown): PdfViewError {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") return new PdfViewError("password", PDF_VIEW_MESSAGES.password);
  if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException") return new PdfViewError("damaged", PDF_VIEW_MESSAGES.damaged);
  return new PdfViewError("failed", PDF_VIEW_MESSAGES.failed);
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

/**
 * Opens the original bytes of a PDF for drawing. The bytes are copied first:
 * pdf.js hands its buffer to the worker (detaching it), and the kept original
 * must stay whole for the next time it is opened or downloaded.
 */
export async function openPdfView(bytes: ArrayBuffer | Uint8Array): Promise<PdfView> {
  const lib = await loadPdfJs().catch(() => {
    throw new PdfViewError("failed", PDF_VIEW_MESSAGES.failed);
  });
  await closing;
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  const task = lib.getDocument({
    data,
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
    wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
    iccUrl: `${PDFJS_ASSET_BASE}iccs/`,
  });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    void task.destroy();
    throw classify(error);
  }

  return {
    pageCount: document.numPages,
    async page(number) {
      let page: Awaited<ReturnType<typeof document.getPage>>;
      try {
        page = await document.getPage(number);
      } catch (error) {
        throw classify(error);
      }
      const base = page.getViewport({ scale: 1 });
      return {
        size: { width: base.width, height: base.height },
        paint(canvas, scale, pixelRatio) {
          const viewport = page.getViewport({ scale });
          canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
          canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
          const render = page.render({ canvas, viewport, ...(pixelRatio !== 1 ? { transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] } : {}) });
          return {
            done: render.promise.catch((error) => {
              if (!isCancellation(error)) throw error;
            }),
            cancel: () => render.cancel(),
          };
        },
        layText(container, scale) {
          const viewport = page.getViewport({ scale });
          // pdf.js sizes and positions the text from these (its own viewer sets them on each page).
          container.style.setProperty("--total-scale-factor", String(scale));
          container.style.setProperty("--scale-round-x", "1px");
          container.style.setProperty("--scale-round-y", "1px");
          const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
          return {
            done: layer.render().then(() => undefined),
            cancel: () => layer.cancel(),
          };
        },
        release: () => page.cleanup(),
      };
    },
    destroy() {
      const done = task.destroy();
      closing = closing.then(() => done).catch(() => undefined);
      return done;
    },
  };
}
