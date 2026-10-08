import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  DESKTOP_IMPORT_REQUESTED_EVENT,
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_IMPORT_TABS,
  outcomeFromIngestion,
  readDesktopImportRequest,
} from "./import-protocol"
import { MAX_INGEST_BATCH, type IngestOutcome } from "@/lib/resources/ingest"
// The extension's copy (plain JS, no build step).
import { DESKTOP_BRIDGE_PORTS, DESKTOP_MAX_TABS, DESKTOP_PROTOCOL_VERSION as EXTENSION_PROTOCOL_VERSION } from "../../../extension/src/desktop.js"

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

  it("on the event the webview listens for", () => {
    expect(rust).toContain(`pub const REQUESTED_EVENT: &str = "${DESKTOP_IMPORT_REQUESTED_EVENT}";`)
  })

  it("on the scheme that starts Hubble, which the installer registers", () => {
    expect(tauriConfig.plugins["deep-link"].desktop.schemes).toEqual(["hubble"])
  })
})

describe("readDesktopImportRequest", () => {
  const now = 1_000_000

  it("takes a batch Rust validated", () => {
    expect(
      readDesktopImportRequest(
        { requestId: "req-12345678", tabs: [{ url: "https://example.com/a", title: " A ", favicon: "https://example.com/f.ico" }], received: 1, rejected: 0, expiresInMs: 180_000 },
        now
      )
    ).toEqual({ requestId: "req-12345678", tabs: [{ url: "https://example.com/a", title: "A", favicon: "https://example.com/f.ico" }], received: 1, rejected: 0, expiresAt: now + 180_000 })
  })

  it("drops what isn't a web address and counts it with Rust's refusals", () => {
    const request = readDesktopImportRequest(
      { requestId: "req-12345678", tabs: [{ url: "https://ok.example" }, { url: "javascript:alert(1)" }, { url: 42 }, null], received: 6, rejected: 2, expiresInMs: 1000 },
      now
    )
    expect(request?.tabs).toEqual([{ url: "https://ok.example" }])
    expect(request?.received).toBe(6)
    expect(request?.rejected).toBe(5)
  })

  it("refuses something that isn't a request at all", () => {
    expect(readDesktopImportRequest(null, now)).toBeUndefined()
    expect(readDesktopImportRequest({ requestId: "../x", tabs: [] }, now)).toBeUndefined()
    expect(readDesktopImportRequest({ requestId: "req-12345678", tabs: "x" }, now)).toBeUndefined()
  })

  it("never takes more than one batch's worth", () => {
    const tabs = Array.from({ length: MAX_DESKTOP_IMPORT_TABS + 10 }, (_, i) => ({ url: `https://example.com/${i}` }))
    expect(readDesktopImportRequest({ requestId: "req-12345678", tabs, received: tabs.length, rejected: 0 }, now)?.tabs).toHaveLength(MAX_DESKTOP_IMPORT_TABS)
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
