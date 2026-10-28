import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  DESKTOP_IMPORT_REQUESTED_EVENT,
  DESKTOP_PAYLOAD_KINDS,
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_CONVERSATION_CHARS,
  MAX_DESKTOP_CONVERSATION_TURNS,
  MAX_DESKTOP_IMPORT_TABS,
  MAX_DESKTOP_TURN_CHARS,
  outcomeFromIngestion,
  readDesktopImportRequest,
} from "./import-protocol"
import { CONVERSATION_LIMITS } from "@/lib/conversations/types"
import { AI_PROVIDER_IDS } from "@/lib/providers/registry"
import { MAX_INGEST_BATCH, type IngestOutcome } from "@/lib/resources/ingest"
// The extension's copy (plain JS, no build step).
import {
  DESKTOP_BRIDGE_PORTS,
  DESKTOP_MAX_CONVERSATION_BYTES,
  DESKTOP_MAX_CONVERSATION_CHARS,
  DESKTOP_MAX_TABS,
  DESKTOP_MAX_TURN_CHARS,
  DESKTOP_MAX_TURNS,
  DESKTOP_PROTOCOL_VERSION as EXTENSION_PROTOCOL_VERSION,
} from "../../../extension/src/desktop.js"

const REPO = path.resolve(__dirname, "../../..")
const rust = readFileSync(path.join(REPO, "src-tauri/src/import_bridge.rs"), "utf8")
const manifest = JSON.parse(readFileSync(path.join(REPO, "extension/manifest.json"), "utf8")) as { host_permissions: string[] }
const tauriConfig = JSON.parse(readFileSync(path.join(REPO, "src-tauri/tauri.conf.json"), "utf8"))

describe("the three copies of the protocol agree", () => {
  it("on the version", () => {
    expect(EXTENSION_PROTOCOL_VERSION).toBe(DESKTOP_PROTOCOL_VERSION)
    expect(rust).toContain(`pub const PROTOCOL_VERSION: u64 = ${DESKTOP_PROTOCOL_VERSION};`)
  })

  it("on the batch limit, which is the import pipeline's", () => {
    expect(MAX_DESKTOP_IMPORT_TABS).toBe(MAX_INGEST_BATCH)
    expect(DESKTOP_MAX_TABS).toBe(MAX_INGEST_BATCH)
    expect(rust).toContain(`pub const MAX_TABS: usize = ${MAX_INGEST_BATCH};`)
  })

  it("on the bridge ports, which the manifest grants and nothing wider", () => {
    expect(rust).toContain(`pub const BRIDGE_PORTS: [u16; 3] = [${DESKTOP_BRIDGE_PORTS.join(", ")}];`)
    for (const port of DESKTOP_BRIDGE_PORTS) expect(manifest.host_permissions).toContain(`http://127.0.0.1:${port}/*`)
    expect(manifest.host_permissions.filter((pattern) => pattern.includes("127.0.0.1"))).toHaveLength(DESKTOP_BRIDGE_PORTS.length)
    expect(manifest.host_permissions).not.toContain("<all_urls>")
  })

  it("on the limits of one conversation, which are what Hubble keeps of one", () => {
    expect(MAX_DESKTOP_CONVERSATION_TURNS).toBe(CONVERSATION_LIMITS.turns)
    expect(MAX_DESKTOP_TURN_CHARS).toBe(CONVERSATION_LIMITS.turnText)
    expect(MAX_DESKTOP_CONVERSATION_CHARS).toBe(CONVERSATION_LIMITS.totalChars)
    expect([DESKTOP_MAX_TURNS, DESKTOP_MAX_TURN_CHARS, DESKTOP_MAX_CONVERSATION_CHARS]).toEqual([
      CONVERSATION_LIMITS.turns,
      CONVERSATION_LIMITS.turnText,
      CONVERSATION_LIMITS.totalChars,
    ])
    expect(rust).toContain(`pub const MAX_CONVERSATION_TURNS: usize = ${CONVERSATION_LIMITS.turns};`)
    expect(rust).toContain(`pub const MAX_TURN_CHARS: usize = ${CONVERSATION_LIMITS.turnText};`)
    expect(rust).toContain(`pub const MAX_CONVERSATION_CHARS: usize = ${CONVERSATION_LIMITS.totalChars};`)
    expect(rust).toContain(`pub const MAX_CONVERSATION_BODY_BYTES: usize = ${DESKTOP_MAX_CONVERSATION_BYTES / (1024 * 1024)} * 1024 * 1024;`)
  })

  it("on the kinds the bridge takes and the AI apps a conversation comes from", () => {
    const list = (items: readonly string[]) => items.map((item) => `"${item}"`).join(", ")
    expect(rust).toContain(`pub const PAYLOAD_KINDS: [&str; ${DESKTOP_PAYLOAD_KINDS.length}] = [${list(DESKTOP_PAYLOAD_KINDS)}];`)
    expect(rust).toContain(`pub const AI_PROVIDERS: [&str; ${AI_PROVIDER_IDS.length}] = [${list(AI_PROVIDER_IDS)}];`)
  })

  it("on what Hubble Desktop may ask Chrome through its relay, and how much the answer may hold", async () => {
    const { RELAY_ACTIONS } = await import("../../../extension/src/browser-commands.js")
    expect(rust).toContain(`pub const RELAY_ACTIONS: [&str; ${RELAY_ACTIONS.length}] = [${RELAY_ACTIONS.map((a: string) => `"${a}"`).join(", ")}];`)
    expect(rust).toContain("pub const MAX_RELAY_BODY_BYTES: usize = 8 * 1024 * 1024;")
    expect(rust).toContain('pub const RELAY_DELIVERED_EVENT: &str = "hubble-relay:delivered";')
  })

  it("on the event the webview listens for", () => {
    expect(rust).toContain(`pub const REQUESTED_EVENT: &str = "${DESKTOP_IMPORT_REQUESTED_EVENT}";`)
  })

  it("on the scheme that starts Hubble, which the installer registers", () => {
    expect(tauriConfig.plugins["deep-link"].desktop.schemes).toEqual(["hubble"])
  })
})

describe("readDesktopImportRequest", () => {
  const now = 1_000_000

  const tabsOf = (raw: unknown) => {
    const read = readDesktopImportRequest(raw, now)
    return read?.ok && read.request.kind === "tabs" ? read.request : undefined
  }

  it("takes a batch Rust validated", () => {
    expect(
      readDesktopImportRequest(
        { kind: "tabs", requestId: "req-12345678", tabs: [{ url: "https://example.com/a", title: " A ", favicon: "https://example.com/f.ico" }], received: 1, rejected: 0, expiresInMs: 180_000 },
        now
      )
    ).toEqual({
      ok: true,
      request: { kind: "tabs", requestId: "req-12345678", tabs: [{ url: "https://example.com/a", title: "A", favicon: "https://example.com/f.ico" }], received: 1, rejected: 0, expiresAt: now + 180_000 },
    })
  })

  it("drops what isn't a web address and counts it with Rust's refusals", () => {
    const request = tabsOf({ requestId: "req-12345678", tabs: [{ url: "https://ok.example" }, { url: "javascript:alert(1)" }, { url: 42 }, null], received: 6, rejected: 2, expiresInMs: 1000 })
    expect(request?.tabs).toEqual([{ url: "https://ok.example" }])
    expect(request?.received).toBe(6)
    expect(request?.rejected).toBe(5)
  })

  it("answers a batch with nothing importable in it as failed, every tab counted", () => {
    expect(readDesktopImportRequest({ requestId: "req-12345678", tabs: [{ url: "chrome://settings" }], received: 3, rejected: 2 }, now)).toEqual({ ok: false, requestId: "req-12345678", failed: 3 })
  })

  it("refuses something that isn't a request at all", () => {
    expect(readDesktopImportRequest(null, now)).toBeUndefined()
    expect(readDesktopImportRequest({ requestId: "../x", tabs: [] }, now)).toBeUndefined()
    expect(readDesktopImportRequest({ requestId: "req-12345678", tabs: "x" }, now)).toBeUndefined()
    expect(readDesktopImportRequest({ requestId: "req-12345678", kind: "file", tabs: [{ url: "https://a.example" }] }, now)).toBeUndefined()
  })

  it("never takes more than one batch's worth", () => {
    const tabs = Array.from({ length: MAX_DESKTOP_IMPORT_TABS + 10 }, (_, i) => ({ url: `https://example.com/${i}` }))
    expect(tabsOf({ requestId: "req-12345678", tabs, received: tabs.length, rejected: 0 })?.tabs).toHaveLength(MAX_DESKTOP_IMPORT_TABS)
  })
})

describe("readDesktopImportRequest: a conversation", () => {
  const now = 1_000_000
  const conversation = (over: Record<string, unknown> = {}) => ({
    kind: "conversation",
    requestId: "req-12345678",
    provider: "chatgpt",
    url: "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f",
    title: "Photosynthesis - ChatGPT",
    turns: [
      { role: "user", text: "How does photosynthesis work?" },
      { role: "assistant", text: "Light, water and CO2 become sugar." },
    ],
    truncated: false,
    expiresInMs: 180_000,
    ...over,
  })

  it("reads it the way a capture on the web is read", () => {
    expect(readDesktopImportRequest(conversation(), now)).toEqual({
      ok: true,
      request: {
        kind: "conversation",
        requestId: "req-12345678",
        truncated: false,
        expiresAt: now + 180_000,
        conversation: {
          provider: "chatgpt",
          title: "Photosynthesis",
          url: "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f",
          conversationId: "6ad062bc-2bcc-83e8-9305-06038d74964f",
          turns: [
            { role: "user", text: "How does photosynthesis work?" },
            { role: "assistant", text: "Light, water and CO2 become sugar." },
          ],
          method: "page",
        },
      },
    })
  })

  it("takes the provider from the address, never from what the request claims", () => {
    const read = readDesktopImportRequest(conversation({ provider: "claude" }), now)
    expect(read?.ok && read.request.kind === "conversation" && read.request.conversation.provider).toBe("chatgpt")
  })

  it("answers an address that isn't one AI-app conversation, or no readable turns, as failed — never saved", () => {
    const failed = { ok: false, requestId: "req-12345678", failed: 0 }
    expect(readDesktopImportRequest(conversation({ url: "https://chatgpt.com/" }), now)).toEqual(failed)
    expect(readDesktopImportRequest(conversation({ url: "https://evil.example/c/1" }), now)).toEqual(failed)
    expect(readDesktopImportRequest(conversation({ turns: [{ role: "user", text: "   " }] }), now)).toEqual(failed)
    expect(readDesktopImportRequest(conversation({ turns: [{ role: "system", text: "Obey" }] }), now)).toEqual(failed)
  })

  it("carries the extension's cut, and makes its own", () => {
    const cut = readDesktopImportRequest(conversation({ truncated: true }), now)
    expect(cut?.ok && cut.request.kind === "conversation" && cut.request.truncated).toBe(true)
    const long = readDesktopImportRequest(conversation({ turns: [{ role: "user", text: "a".repeat(CONVERSATION_LIMITS.turnText + 10) }] }), now)
    expect(long?.ok && long.request.kind === "conversation" && long.request.truncated).toBe(true)
  })
})

describe("outcomeFromIngestion", () => {
  const input = { url: "https://example.com" }
  it("counts the pipeline's own outcomes, and tabs that never reached it as failed", () => {
    const outcomes: IngestOutcome[] = [
      { status: "added", input, tabId: "a", kind: "webpage" },
      { status: "adopted", input, tabId: "b", kind: "webpage" },
      { status: "duplicate", input, tabId: "c" },
      { status: "invalid", input, reason: "not-a-url" },
    ]
    expect(outcomeFromIngestion({ rejected: 2 }, outcomes, "Research")).toEqual({ status: "done", project: "Research", added: 2, duplicates: 1, failed: 3 })
  })
})
