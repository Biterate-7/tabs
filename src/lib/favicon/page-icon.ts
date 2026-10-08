/**
 * The icon Chrome itself showed for a page (`chrome.tabs.Tab.favIconUrl`),
 * carried with a tab the extension imported and kept on `Tab.favicon`.
 *
 * It is the best icon Hubble can have: Chrome already loaded it, with the
 * person's own session, for the exact page — so it is right for a signed-in
 * app (ChatGPT, Drive) whose public home page shows something else, and for
 * a Google Docs/Sheets/Slides tab that shares a host with its siblings.
 * TabFavicon draws it first and falls back to Hubble's resolver
 * (./client.ts) when it can't.
 *
 * Stored tabs are untrusted (local storage, hand-edited exports), so the
 * value is re-read wherever it enters and wherever it is drawn.
 */

/** A remote icon address, as Chrome reports it. Matches the import bridge's URL bound. */
export const MAX_PAGE_ICON_URL_CHARS = 2048;
/** An inline icon (some sites declare one): small enough to keep on the tab in local storage. */
export const MAX_PAGE_ICON_DATA_CHARS = 8 * 1024;

const DATA_IMAGE = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml|bmp)(?:;[a-z0-9=.+-]*)*,/i;

/** `raw` as a page icon Hubble may keep — an http(s) address or a small inline image — or undefined. */
export function readPageIcon(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (/^data:/i.test(value)) return value.length <= MAX_PAGE_ICON_DATA_CHARS && DATA_IMAGE.test(value) ? value : undefined;
  if (value.length > MAX_PAGE_ICON_URL_CHARS) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page icon this platform can draw straight from an <img>, or null.
 *
 * The desktop app's CSP allows images only from itself, `data:` and `blob:`
 * (src/lib/platform/desktop-config.test.ts guards that), so a remote
 * address can't load there and the resolver answers instead. On the web any
 * address may load; one that fails falls back the same way.
 */
export function drawablePageIcon(raw: unknown, platform: "web" | "desktop"): string | null {
  const icon = readPageIcon(raw);
  if (!icon) return null;
  return platform === "web" || /^data:/i.test(icon) ? icon : null;
}
