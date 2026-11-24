import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { errorMessage, intelligenceEvents, intelligenceStatus, logIntelligence, resetIntelligenceDiagnosticsForTests, subscribeIntelligence, updateIntelligenceStatus } from "./diagnostics"

/**
 * The diagnostics log is bounded and holds only small values; warnings reach
 * the console; and the embedding worker's model configuration — which only a
 * real browser can exercise — is pinned here.
 */

beforeEach(() => resetIntelligenceDiagnosticsForTests())

describe("the intelligence log", () => {
  it("keeps numbers, booleans and short strings only, each bounded", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const event = logIntelligence({ level: "warn", kind: "store", event: "x", message: "m".repeat(2_000), data: { count: 3, ok: true, id: "w1:s:t1", long: "y".repeat(500), nested: { a: 1 } as unknown as number, bad: Number.NaN } })
    expect(event.message!.length).toBeLessThanOrEqual(400)
    expect(event.data).toEqual({ count: 3, ok: true, id: "w1:s:t1", long: expect.any(String), bad: 0 })
    expect((event.data!.long as string).length).toBeLessThanOrEqual(160)
  })

  it("is a ring: the newest 300 events", () => {
    for (let n = 0; n < 350; n++) logIntelligence({ level: "info", kind: "backfill", event: `e${n}` })
    expect(intelligenceEvents()).toHaveLength(300)
    expect(intelligenceEvents()[0]!.event).toBe("e50")
  })

  it("sends warnings and errors to the console, and tells subscribers about status changes", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const listener = vi.fn()
    const stop = subscribeIntelligence(listener)
    logIntelligence({ level: "error", kind: "store", event: "cache-write-failed", message: "QuotaExceededError" })
    updateIntelligenceStatus({ model: { state: "unavailable", reason: "no model" } })
    stop()
    expect(error).toHaveBeenCalledWith(expect.stringContaining("store/cache-write-failed: QuotaExceededError"), "")
    expect(listener).toHaveBeenCalledTimes(2)
    expect(intelligenceStatus().model).toEqual({ state: "unavailable", reason: "no model" })
  })

  it("words errors without throwing on odd inputs", () => {
    expect(errorMessage(new TypeError("bad"))).toBe("TypeError: bad")
    expect(errorMessage(new Error("plain"))).toBe("plain")
    expect(errorMessage("text")).toBe("text")
    expect(errorMessage(undefined)).toBe("Unknown error")
  })
})

describe("the embedding worker's model configuration", () => {
  const source = readFileSync(path.join(import.meta.dirname, "embedding.worker.ts"), "utf8")

  it("loads Hubble's own copy of the model and never a download", () => {
    expect(source).toMatch(/env\.allowRemoteModels = false/)
    expect(source).toMatch(/env\.allowLocalModels = true/)
  })

  it("uses a root-relative model path — a full URL makes transformers.js build the pipeline without a tokenizer", () => {
    // Found on Hubble Desktop (and reproduced in Chrome): with an http(s) localModelPath, transformers.js 4 reports
    // tokenizer_config.json missing, and every embedding fails with "this.tokenizer is not a function".
    expect(source).toMatch(/env\.localModelPath = "\/models\/"/)
    expect(source).not.toMatch(/localModelPath = new URL/)
  })
})
