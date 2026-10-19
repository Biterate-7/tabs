import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"
import { extractFile } from "./extract"
import { bytesHash } from "./formats"
import { mathExamPdf } from "./__fixtures__/pdf"
import { getContent, getFile, putContent, putFile, resetContentStoreForTests } from "@/lib/resources/content-store"
import { isPdfBytes } from "@/lib/resources/pdf"

/**
 * What the reader draws and what search and AI quote both come from the
 * device, so both must outlive the page that stored them: a reload, a
 * browser restart or the desktop app being closed and opened again.
 * "Restart" here is the content store forgetting everything it holds in
 * memory (its open connection, its fallback) while IndexedDB keeps the data.
 */

const NOW = Date.UTC(2026, 9, 19)

afterEach(() => resetContentStoreForTests())

describe("the original and its text survive a restart", () => {
  it("gives back the same PDF bytes, untouched, and the text read from them", async () => {
    const original = mathExamPdf()
    const extraction = await extractFile(original, "pdf", NOW)
    if (extraction.status !== "ready") throw new Error("expected text")
    await putFile("w", "n1", original.slice().buffer, { name: "Mathematics Paper 1.pdf", type: "application/pdf", now: NOW })
    await putContent("w", "n1", extraction.content)

    resetContentStoreForTests()

    const file = await getFile("w", "n1")
    expect(file?.name).toBe("Mathematics Paper 1.pdf")
    const bytes = new Uint8Array(file!.bytes)
    expect(isPdfBytes(bytes)).toBe(true)
    expect(bytes).toEqual(original)
    const content = await getContent("w", "n1")
    expect(content?.pages).toHaveLength(3)
    expect(content?.pages?.[0]).toContain("Solve the quadratic equation")
  })

  it("is still the same file to the duplicate check after a restart", async () => {
    const original = mathExamPdf()
    await putFile("w", "n1", original.slice().buffer, { name: "a.pdf", type: "application/pdf", now: NOW })
    resetContentStoreForTests()
    const kept = new Uint8Array((await getFile("w", "n1"))!.bytes)
    expect(bytesHash(kept)).toBe(bytesHash(mathExamPdf()))
  })

  it("keeps each project's originals apart", async () => {
    await putFile("w1", "n1", mathExamPdf().slice().buffer, { name: "a.pdf", type: "application/pdf", now: NOW })
    resetContentStoreForTests()
    expect(await getFile("w2", "n1")).toBeUndefined()
    expect(await getFile("w1", "n1")).toBeDefined()
  })
})
