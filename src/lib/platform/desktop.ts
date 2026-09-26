import type { PlatformAdapter } from "./types";

/**
 * The Tauri implementation.
 *
 * Every Tauri import in this file is a *dynamic* `import()` inside the
 * function that needs it, never a top-level one. That is what guarantees
 * `@tauri-apps/api` is code-split into a chunk the web build never
 * requests — a static import would pull the Tauri runtime into the
 * browser bundle, where its absence is a load-time error rather than a
 * capability that simply isn't used. `platform/no-tauri-in-web.test.ts`
 * asserts this property so it can't regress.
 *
 * Both calls land on app-defined Rust commands (src-tauri/src/commands.rs)
 * rather than on Tauri's JS plugins. The frontend therefore cannot open a
 * non-http(s) URL or name a filesystem path at all — those constraints are
 * enforced on the Rust side, below the IPC boundary.
 */

async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** A folder the user chose in the native dialog (Phase J.1). */
export type PickedProjectFolder = { path: string; name: string };

/**
 * The desktop app's agent runtime bridge (Phase J.1).
 *
 * Not part of `PlatformAdapter`: the web has no equivalent — its agent
 * runtime is an HTTP route — so this is a desktop-only transport rather than
 * a capability both shells implement differently.
 *
 * Both calls land on app-defined Rust commands (src-tauri/src/agent_runtime.rs)
 * that relay to the bundled runtime sidecar. The request is the same closed
 * runtime protocol the web posts to `/api/agents/control`; Rust additionally
 * refuses any project folder the user did not pick through
 * `pickProjectFolder`, which is the only way a path enters.
 */
export const desktopAgentBridge = {
  async request(body: unknown): Promise<unknown> {
    const raw = await invokeCommand<string>("agent_runtime", { request: JSON.stringify(body) });
    return JSON.parse(raw) as unknown;
  },

  async pickProjectFolder(): Promise<PickedProjectFolder | null> {
    return invokeCommand<PickedProjectFolder | null>("agent_pick_project_folder", {});
  },
};

export const desktopPlatform: PlatformAdapter = {
  kind: "desktop",

  /** Hands the URL to the user's default browser — see `open_external`. */
  async openExternal(url: string): Promise<void> {
    await invokeCommand<void>("open_external", { url });
  },

  /**
   * Shows a native "Save as…" dialog and writes the chosen file. `false`
   * covers the user cancelling as well as a write that failed; the Rust
   * side distinguishes them, and only a genuine failure rejects.
   */
  async saveTextFile(filename: string, text: string): Promise<boolean> {
    try {
      return await invokeCommand<boolean>("export_text_file", {
        suggestedName: filename,
        contents: text,
      });
    } catch {
      return false;
    }
  },
};
