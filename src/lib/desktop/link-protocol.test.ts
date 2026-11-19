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
