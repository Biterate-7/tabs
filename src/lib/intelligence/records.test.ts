import { describe, expect, it } from "vitest"
import { describeCapture, mergeRecords, readActivityRecord, upsertRecords, willSaveText } from "./records"

const base = {
  url: "https://www.economicshelp.org/blog/sugar-tax/?utm_source=newsletter#top",
  title: "Sugar taxes and negative externalities",
  firstSeenAt: 1000,
  lastSeenAt: 2000,
  visits: 2,
  dwellMs: 60_000,
  days: ["2026-10-27", "2026-10-28"],
  kind: "article",
  capture: { status: "metadata", method: "tab-metadata" },
}

describe("readActivityRecord", () => {
  it("keys a page by Hubble's own source identity", () => {
    expect(readActivityRecord(base)?.key).toBe("economicshelp.org/blog/sugar-tax")
    expect(readActivityRecord({ ...base, url: "https://chat.openai.com/c/6720a1b2-0000-4000-8000-000000000001?model=gpt-4o", kind: "conversation" })).toMatchObject({
      key: "conversation:chatgpt:chat:6720a1b2-0000-4000-8000-000000000001",
      provider: "chatgpt",
      kind: "conversation",
    })
  })

  it("refuses what should never have been collected, and malformed records", () => {
    expect(readActivityRecord({ ...base, url: "https://mail.google.com/mail/u/0/#inbox" })).toBeUndefined()
    expect(readActivityRecord({ ...base, url: "javascript:alert(1)" })).toBeUndefined()
    expect(readActivityRecord({ ...base, firstSeenAt: "yesterday" })).toBeUndefined()
    expect(readActivityRecord(null)).toBeUndefined()
  })

  it("never believes a content claim that didn't come from reading the page", () => {
    const forged = readActivityRecord({ ...base, capture: { status: "content", method: "tab-metadata" }, terms: ["sugar"] })
    expect(forged?.capture.status).toBe("metadata")
    expect(forged?.terms).toBeUndefined()
  })

  it("decides the AI app from the address, never from what the record says", () => {
    expect(readActivityRecord({ ...base, provider: "claude", kind: "conversation" })).toMatchObject({ kind: "webpage" })
    expect(readActivityRecord({ ...base, provider: "claude" })?.provider).toBeUndefined()
  })

  it("keeps only plain topic words from a read", () => {
    const read = readActivityRecord({ ...base, capture: { status: "content", method: "page-read", turnCount: 4 }, terms: ["sugar", "Tax", "<script>", "ok", "a".repeat(40), "sugar"] })
    expect(read?.terms).toEqual(["sugar"])
  })
})

describe("merging", () => {
  it("keeps the earliest sighting, the latest title, the best read", () => {
    const older = readActivityRecord({ ...base, capture: { status: "content", method: "page-read" }, terms: ["sugar"] })!
    const newer = readActivityRecord({ ...base, title: "Sugar tax (updated)", firstSeenAt: 1500, lastSeenAt: 3000, days: ["2026-10-29"] })!
    const merged = mergeRecords(older, newer)
    expect(merged).toMatchObject({ title: "Sugar tax (updated)", firstSeenAt: 1000, lastSeenAt: 3000, capture: { status: "content" }, terms: ["sugar"] })
    expect(merged.days).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"])
  })

  it("upserting the same page twice leaves one record; nothing new returns the same array", () => {
    const record = readActivityRecord(base)!
    const once = upsertRecords([], [record, { ...record, lastSeenAt: 2500 }])
    expect(once).toHaveLength(1)
    expect(upsertRecords(once, [])).toBe(once)
  })

  it("is bounded", () => {
    const many = Array.from({ length: 20 }, (_, index) => readActivityRecord({ ...base, url: `https://arxiv.org/abs/${index}`, lastSeenAt: 2000 + index })!)
    const kept = upsertRecords([], many, 5)
    expect(kept.map((record) => record.key)).toEqual(["arxiv.org/abs/19", "arxiv.org/abs/18", "arxiv.org/abs/17", "arxiv.org/abs/16", "arxiv.org/abs/15"])
  })
})

describe("capture status in words", () => {
  it("says exactly how much is known", () => {
    expect(describeCapture(readActivityRecord(base)!).label).toBe("Title only")
    expect(describeCapture(readActivityRecord({ ...base, title: "" })!).label).toBe("Address only")
    expect(describeCapture(readActivityRecord({ ...base, capture: { status: "partial", method: "page-read" } })!).complete).toBe(false)
    expect(describeCapture(readActivityRecord({ ...base, capture: { status: "unavailable", method: "page-read", gap: "layout" } })!)).toMatchObject({ label: "Couldn't read", detail: expect.stringMatching(/layout/) })
  })

  it("a conversation's text can be saved only while its tab is open and readable", () => {
    const chat = readActivityRecord({ ...base, url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001", kind: "conversation", open: true, capture: { status: "content", method: "page-read" }, terms: ["sugar"] })!
    expect(willSaveText(chat)).toBe(true)
    expect(willSaveText({ ...chat, open: false })).toBe(false)
    expect(willSaveText({ ...chat, capture: { status: "metadata", method: "tab-metadata" } })).toBe(false)
  })
})
