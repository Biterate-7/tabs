/**
 * The capabilities that genuinely differ between the browser and the
 * desktop shell. Kept deliberately tiny: a capability earns a place here
 * only when the browser implementation would be *wrong* on desktop, not
 * merely when Tauri offers a native alternative.
 *
 * Two qualify today:
 *
 * - `openExternal` — on the web, clicking a saved tab reuses the current
 *   browser tab (see src/lib/browser/open-tab.ts). Doing that on desktop
 *   would navigate the app window to someone else's website and turn
 *   TabDump into a second-rate browser.
 * - `saveTextFile` — the web export builds a blob URL and clicks a hidden
 *   `<a download>`. A Tauri webview has no download UI for that to land
 *   in, so an export would silently go nowhere.
 *
 * Clipboard, file *input* (import), IndexedDB and localStorage are all
 * absent on purpose: they work identically in a WebView2/WKWebView context,
 * so wrapping them would add indirection and buy nothing.
 */
export type PlatformAdapter = {
  readonly kind: "web" | "desktop";

  /** Opens `url` wherever a webpage belongs on this platform. */
  openExternal(url: string): Promise<void>;

  /**
   * Writes `text` out as a file the user keeps.
   *
   * Resolves `true` when the file was written, `false` when it wasn't —
   * which on desktop includes the user cancelling the save dialog, a
   * normal outcome the UI reports differently from a failure.
   */
  saveTextFile(filename: string, text: string, mimeType: string): Promise<boolean>;
};
