/**
 * Single source of truth for how onboarding offers the TabDump extension.
 * There is deliberately no fake Chrome Web Store URL here — until
 * `NEXT_PUBLIC_EXTENSION_STORE_URL` is set to a real listing, onboarding
 * offers the packaged extension ZIP (see scripts/build-extension-zip.mjs)
 * with an install guide, in both development and production alike, rather
 * than linking somewhere fake.
 *
 * To go live on the Chrome Web Store: set NEXT_PUBLIC_EXTENSION_STORE_URL
 * in the production environment (e.g. Vercel project settings) to the real
 * listing URL once one exists. The primary action then switches
 * automatically from "Download Extension" to "Install from Chrome Web
 * Store" with no other code changes.
 */
export type ExtensionInstallInfo = { mode: "download" } | { mode: "store"; url: string };

export function getExtensionInstallInfo(): ExtensionInstallInfo {
  const storeUrl = process.env.NEXT_PUBLIC_EXTENSION_STORE_URL;
  if (storeUrl) return { mode: "store", url: storeUrl };
  return { mode: "download" };
}

/** Where the packaged extension ZIP is served from (see the build script). */
export const EXTENSION_DOWNLOAD_URL = "/tabdump-extension.zip";
