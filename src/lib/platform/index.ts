/**
 * The single entry point for platform-varying behaviour.
 *
 * Importing `desktop.ts` statically here is safe and intentional: that
 * module holds no top-level Tauri import, only dynamic ones inside its
 * functions, so the Tauri runtime stays out of the web bundle while the
 * adapter itself costs a few bytes.
 */
import { isDesktop } from "./detect";
import { desktopImportBridge, desktopPlatform } from "./desktop";
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
