import { markMatches } from "@/lib/resources/search";

/**
 * Search words marked on a drawn PDF page.
 *
 * A page is a picture with Hubble's invisible text laid over it (pdf-view's
 * `layText`). The words a person searched for are found in that text with the
 * same matching the search itself uses (markMatches), and painted with the
 * browser's CSS Custom Highlight API — which colours text ranges without
 * touching the DOM, so selection and the page's layout are undisturbed. A
 * browser without the API shows the page without marks; the search hit still
 * opens at the right page.
 */

/** The `::highlight()` name globals.css styles. */
export const PDF_HIGHLIGHT_NAME = "hubble-pdf-match";

/** Ranges over the words in `root`'s text that match any of `terms`. */
export function findMatchRanges(root: HTMLElement, terms: readonly string[]): Range[] {
  if (terms.length === 0) return [];
  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    let offset = 0;
    for (const part of markMatches(text, terms)) {
      if (part.match) {
        const range = root.ownerDocument.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + part.text.length);
        ranges.push(range);
      }
      offset += part.text.length;
    }
  }
  return ranges;
}

type HighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };

function registry(): HighlightRegistry | undefined {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? css.highlights : undefined;
}

/** Paints these ranges as the page marks; an empty list clears them. */
export function paintMatches(ranges: readonly Range[]): void {
  const highlights = registry();
  if (!highlights) return;
  if (ranges.length === 0) {
    highlights.delete(PDF_HIGHLIGHT_NAME);
    return;
  }
  const Highlight = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  highlights.set(PDF_HIGHLIGHT_NAME, new Highlight(...ranges));
}
