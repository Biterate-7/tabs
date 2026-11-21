// @vitest-environment node
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { readPageRequest } from "@/lib/memory/extension-protocol"
import { LINK_REQUEST_KINDS } from "../../../extension/src/desktop-link.js"

const ROOT = path.resolve(__dirname, "../../..")

describe("the paired link's request kinds", () => {
  it("are the same in Rust, the extension and the webview's schema", () => {
    const rust = readFileSync(path.join(ROOT, "src-tauri", "src", "extension_link.rs"), "utf8")
    const declared = rust.match(/pub const LINK_REQUEST_KINDS: \[&str; \d+\] = \[([^\]]+)\]/)
    expect(declared).not.toBeNull()
    const rustKinds = JSON.parse("[" + declared![1] + "]")
    expect(rustKinds).toEqual(LINK_REQUEST_KINDS)

    // Every kind the link carries is one the webview reads (with arguments it accepts); nothing else is.
    const minimal: Record<string, unknown> = {
      projects: {},
      capture: { workspaceId: "w", capture: {} },
      saved: { url: "https://chatgpt.com/c/1" },
      search: { query: "x" },
      bundle: { workspaceId: "w", refs: [{ kind: "note", noteId: "n" }] },
      reused: { workspaceId: "w", items: 1, how: "copied" },
      "save-session": { tabs: [{ url: "https://example.com" }] },
      "add-sources": { workspaceId: "w", tabs: [{ url: "https://example.com" }] },
    }
    for (const kind of LINK_REQUEST_KINDS as string[]) {
      expect(readPageRequest({ requestId: "r", kind, args: minimal[kind] }), kind).toBeDefined()
    }
    expect(readPageRequest({ requestId: "r", kind: "exec", args: {} })).toBeUndefined()
  })
})

describe("the commands Hubble Desktop sends the paired extension", () => {
  it("are the same allowlist in Rust and the extension, and each is a browser command the extension validates", async () => {
    const rust = readFileSync(path.join(ROOT, "src-tauri", "src", "extension_link.rs"), "utf8")
    const declared = rust.match(/pub const LINK_COMMAND_ACTIONS: \[&str; (\d+)\] = \[([^\]]+)\]/)
    expect(declared).not.toBeNull()
    const rustActions = JSON.parse("[" + declared![2].replace(/,\s*$/, "") + "]")
    expect(rustActions).toHaveLength(Number(declared![1]))
    const { DESKTOP_COMMAND_ACTIONS } = await import("../../../extension/src/desktop-link.js")
    expect(rustActions).toEqual([...DESKTOP_COMMAND_ACTIONS])

    const { ALLOWED_BROWSER_ACTIONS } = await import("../../../extension/src/browser-commands.js")
    for (const action of rustActions) expect(ALLOWED_BROWSER_ACTIONS, action).toContain(action)
    // Never the tab-closing and window-moving commands, and nothing that reaches a relay.
    for (const never of ["close_tab", "close_tabs", "pin_tab", "unpin_tab", "move_tabs_to_window", "create_browser_window", "deliver_to_desktop"]) {
      expect(rustActions).not.toContain(never)
    }
  })

  it("wake the extension through an address it recognises, on Hubble Desktop's ports only", async () => {
    const { isDesktopWakeUrl } = await import("../../../extension/src/desktop-link.js")
    const rust = readFileSync(path.join(ROOT, "src-tauri", "src", "import_bridge.rs"), "utf8")
    expect(rust).toContain('Some(format!("http://127.0.0.1:{port}/v1/wake"))')
    expect(isDesktopWakeUrl("http://127.0.0.1:41517/v1/wake")).toBe(true)
    expect(isDesktopWakeUrl("http://127.0.0.1:41519/v1/wake/")).toBe(true)
    for (const other of ["http://127.0.0.1:8080/v1/wake", "http://localhost:41517/v1/wake", "https://127.0.0.1:41517/v1/wake", "http://127.0.0.1:41517/v1/wake?x=1", "http://127.0.0.1:41517/v1/hello", undefined]) {
      expect(isDesktopWakeUrl(other), String(other)).toBe(false)
    }
  })
})
