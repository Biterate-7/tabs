import type { PlatformAdapter } from "./types";
import { DESKTOP_IMPORT_REQUESTED_EVENT, type DesktopImportOutcome } from "@/lib/desktop/import-protocol";

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

async function invokeCommand<T>(command: string, args: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return headers ? invoke<T>(command, args, { headers }) : invoke<T>(command, args);
}

/**
 * Chrome → Hubble Desktop: the webview's way to the import bridge
 * (src-tauri/src/import_bridge.rs). Rust holds the batches the extension
 * sent; this takes them, says how each one ended, and hears when another
 * arrives. Desktop-only: the web has no bridge.
 */
export const desktopImportBridge = {
  async take(): Promise<unknown[]> {
    return invokeCommand<unknown[]>("desktop_import_take", {});
  },

  async finish(requestId: string, outcome: DesktopImportOutcome): Promise<void> {
    await invokeCommand<void>("desktop_import_finish", { requestId, outcome });
  },

  async onRequested(handler: () => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen(DESKTOP_IMPORT_REQUESTED_EVENT, () => handler());
  },
};

/** What the running Hubble Desktop binary says about itself (`app_info` in src-tauri/src/commands.rs). */
export type DesktopAppInfo = {
  /** `src-tauri/tauri.conf.json` `version`, compiled into this binary. */
  version: string;
  tauriVersion: string;
  /** Rust's `std::env::consts::OS`: "windows", "macos", "linux", … */
  os: string;
  /** Rust's `std::env::consts::ARCH`: "x86_64", "aarch64", … */
  arch: string;
  /** A development (`--debug`) build rather than a release one. */
  debug: boolean;
};

/** The command's answer, checked field by field: a malformed one is an error, not a half-filled screen. */
export function parseDesktopAppInfo(value: unknown): DesktopAppInfo {
  const info = (value ?? {}) as Record<string, unknown>;
  const text = (key: string) => {
    const field = info[key];
    if (typeof field !== "string" || !field) throw new Error(`Hubble Desktop didn't report its ${key}.`);
    return field;
  };
  if (typeof info.debug !== "boolean") throw new Error("Hubble Desktop didn't report its build type.");
  return { version: text("version"), tauriVersion: text("tauriVersion"), os: text("os"), arch: text("arch"), debug: info.debug };
}

export async function desktopAppInfo(): Promise<DesktopAppInfo> {
  return parseDesktopAppInfo(await invokeCommand<unknown>("app_info", {}));
}

/**
 * The Hubble account, as the desktop app holds it (src-tauri/src/account.rs).
 * The device token never reaches this side: Rust keeps it in the OS
 * credential store and attaches it to account requests itself.
 */
export type DesktopAccountStatus = {
  state: "signed-out" | "signed-in" | "offline" | "expired";
  user: { id: string; email: string; name: string; avatarUrl: string | null } | null;
  /** The deployed Hubble this app signs in to. */
  origin: string;
};

export const desktopAccount = {
  status(): Promise<DesktopAccountStatus> {
    return invokeCommand<DesktopAccountStatus>("account_status", {});
  },
  /** Opens Hubble in the default browser to approve this app. */
  beginSignIn(): Promise<void> {
    return invokeCommand<void>("account_sign_in_begin", {});
  },
  /** Finishes with a code pasted from the browser, when the hubble:// link can't. */
  completeSignIn(code: string): Promise<DesktopAccountStatus> {
    return invokeCommand<DesktopAccountStatus>("account_sign_in_complete", { code });
  },
  signOut(): Promise<void> {
    return invokeCommand<void>("account_sign_out", {});
  },
  /** One account API call; rejects (like fetch offline) when the server can't be reached. */
  async request(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    return invokeCommand<{ status: number; body: string }>("account_request", { method, path, body: body ?? null });
  },
  /** Hears when the signed-in state may have changed: a sign-in finished, or a token was refused. */
  async onChanged(handler: () => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen("hubble-account:changed", () => handler());
  },
  /** Hears how a sign-in through the hubble:// link ended. */
  async onSignInResult(handler: (result: { ok: boolean; error: string | null }) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<{ ok: boolean; error: string | null }>("hubble-account:sign-in", (event) => handler(event.payload));
  },
};

/** Asking Chrome through the person's browser (src-tauri/src/import_bridge.rs, "The relay"). */
export const desktopChromeRelay = {
  /** Opens the relay page; resolves the relay id to wait on. */
  begin(action: "browser_tabs" | "history", args: Record<string, unknown>): Promise<string> {
    return invokeCommand<string>("desktop_relay_begin", { action, args });
  },
  take(id: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string } | null> {
    return invokeCommand("desktop_relay_take", { id });
  },
  cancel(id: string): Promise<void> {
    return invokeCommand<void>("desktop_relay_cancel", { id });
  },
  async onDelivered(handler: (id: string) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<{ id: string }>("hubble-relay:delivered", (event) => handler(event.payload.id));
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

  /** The bytes travel as the raw IPC body (not a JSON array); the name rides in a header. See `export_file`. */
  async saveFile(filename: string, bytes: Uint8Array): Promise<boolean> {
    try {
      return await invokeCommand<boolean>("export_file", bytes, { "x-file-name": encodeURIComponent(filename) });
    } catch {
      return false;
    }
  },
};
