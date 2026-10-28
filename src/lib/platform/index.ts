/**
 * The single entry point for platform-varying behaviour.
 *
 * Importing `desktop.ts` statically here is safe and intentional: that
 * module holds no top-level Tauri import, only dynamic ones inside its
 * functions, so the Tauri runtime stays out of the web bundle while the
 * adapter itself costs a few bytes.
 */
import { isDesktop } from "./detect";
import { desktopAccount, desktopAppInfo, desktopImportBridge, desktopPlatform, type DesktopAppInfo } from "./desktop";
import { webPlatform } from "./web";
import type { PlatformAdapter } from "./types";

export { isDesktop, platformKind } from "./detect";
export { apiOrigin, apiUrl } from "./api-base";
export type { PlatformAdapter } from "./types";

/**
 * Resolved per call rather than captured at module load: `isDesktop()`
 * reads a global the Tauri runtime injects, and module evaluation order
 * relative to that injection is not something worth depending on.
 */
function adapter(): PlatformAdapter {
  return isDesktop() ? desktopPlatform : webPlatform;
}

/** Opens a webpage where webpages belong — a browser tab on web, the user's default browser on desktop. */
export function openExternal(url: string): Promise<void> {
  return adapter().openExternal(url);
}

/** Saves `text` as a file: a browser download on web, a native Save dialog on desktop. */
export function saveTextFile(filename: string, text: string, mimeType: string): Promise<boolean> {
  return adapter().saveTextFile(filename, text, mimeType);
}

/** Saves bytes as a file (an uploaded file's original): a browser download on web, a native Save dialog on desktop. */
export function saveFile(filename: string, bytes: Uint8Array, mimeType: string): Promise<boolean> {
  return adapter().saveFile(filename, bytes, mimeType);
}

/**
 * Tabs sent straight from the Chrome extension to Hubble Desktop
 * (src-tauri/src/import_bridge.rs). `undefined` on the web, where the
 * extension delivers through the page instead (useExtensionImport).
 */
export function desktopImport(): typeof desktopImportBridge | undefined {
  return isDesktop() ? desktopImportBridge : undefined;
}

export type { DesktopAppInfo };
export type { DesktopAccountStatus } from "./desktop";

/** The desktop app's account (sign-in through the browser). `undefined` on the web, where the session cookie is the account. */
export function desktopAccountApi(): typeof desktopAccount | undefined {
  return isDesktop() ? desktopAccount : undefined;
}

/**
 * A request to one of Hubble's account APIs (who am I, sync, AI connectors),
 * authenticated as whoever is signed in.
 *
 * On the web that is a same-origin fetch carrying the HttpOnly session
 * cookie, exactly as before. In Hubble Desktop it goes through Rust, which
 * attaches the device token from the OS credential store
 * (src-tauri/src/account.rs) — the token never enters this webview. Either
 * way the caller gets a Response, and an unreachable server rejects like
 * fetch does.
 */
export async function accountFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isDesktop()) return fetch(path, { ...init, credentials: "same-origin" });
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
    throw new TypeError("accountFetch sends JSON text bodies only.");
  }
  let result: { status: number; body: string };
  try {
    result = await desktopAccount.request((init.method ?? "GET").toUpperCase(), path, init.body ?? undefined);
  } catch (error) {
    throw new TypeError(`Couldn't reach Hubble (${error instanceof Error ? error.message : String(error)}).`);
  }
  // 204/304 can't carry a body in the Response constructor.
  const empty = result.status === 204 || result.status === 304;
  return new Response(empty ? null : result.body, { status: result.status, headers: { "content-type": "application/json" } });
}

/**
 * The installed Hubble Desktop's version, OS and build, from the binary
 * itself. `undefined` on the web, where there is no installed app to ask.
 */
export function installedDesktopApp(): Promise<DesktopAppInfo> | undefined {
  return isDesktop() ? desktopAppInfo() : undefined;
}
