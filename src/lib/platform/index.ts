/**
 * The single entry point for platform-varying behaviour.
 *
 * Importing `desktop.ts` statically here is safe and intentional: that
 * module holds no top-level Tauri import, only dynamic ones inside its
 * functions, so the Tauri runtime stays out of the web bundle while the
 * adapter itself costs a few bytes.
 */
import { isDesktop, platformKind } from "./detect";
import { desktopAgentBridge, desktopPlatform } from "./desktop";
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

export type { PickedProjectFolder } from "./desktop";

/**
 * How the agent runtime client reaches the runtime in this shell (Phase J.1).
 *
 * `undefined` on the web, where the client posts to `/api/agents/control` as
 * it always has. On the desktop, the bundled runtime sidecar, through Rust.
 */
export function agentRuntimeTransport(): ((body: unknown) => Promise<unknown>) | undefined {
  return isDesktop() ? (body) => desktopAgentBridge.request(body) : undefined;
}

/**
 * The native folder picker for agent projects, on the desktop only.
 *
 * On the desktop a project folder can only come from here — Rust refuses one
 * that did not. On the web there is no trusted path source, so the typed path
 * and the runtime's validator remain what they were.
 */
export function agentProjectFolderPicker():
  | (() => Promise<{ path: string; name: string } | null>)
  | undefined {
  return isDesktop() ? () => desktopAgentBridge.pickProjectFolder() : undefined;
}

/**
 * Which surface the agent connectors are offered on (Phase J.2).
 *
 * Some connectors only work on one: a custom MCP agent connects to TabDump's
 * MCP server, which only a TabDump server with an account store runs. The
 * connector registry says which; this says where we are.
 */
export function agentConnectorSurface(): "web" | "desktop" {
  return platformKind();
}
