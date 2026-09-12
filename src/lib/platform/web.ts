import type { PlatformAdapter } from "./types";

/**
 * The browser implementation — deliberately the code that was already
 * there, moved rather than rewritten, so the web app's behaviour is
 * unchanged byte for byte.
 */

/**
 * Builds a blob URL and clicks a hidden `<a download>`. This is the exact
 * mechanism src/lib/workspace/export.ts and json-export.ts have always
 * used; it lives here now so both of them, and the desktop adapter, share
 * one definition of "save this text as a file".
 */
export function downloadViaAnchor(filename: string, text: string, mimeType: string): boolean {
  try {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

export const webPlatform: PlatformAdapter = {
  kind: "web",

  /**
   * Not reached by the saved-tab path — src/lib/browser/open-tab.ts keeps
   * its own, richer web behaviour (reuse the current tab, or let the
   * extension activate an already-open one). This is the plain fallback for
   * any other caller that just wants a URL opened.
   */
  async openExternal(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  },

  async saveTextFile(filename: string, text: string, mimeType: string): Promise<boolean> {
    return downloadViaAnchor(filename, text, mimeType);
  },
};
