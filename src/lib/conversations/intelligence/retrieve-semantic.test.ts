import { describe, expect, it } from "vitest"
import { NOW, photosynthesisChat, storageChoiceChat, syncBugChat } from "./__fixtures__/conversations"
import { buildConversationIndex } from "./corpus"
import { extractConversation } from "./extract"
import { RETRIEVAL_CONFIG, answerQuery, parseQuery } from "./retrieve"
import { DEFAULT_INTELLIGENCE_SETTINGS } from "./settings"
import type { SemanticHits } from "./semantic-client"

/**
 * Questions answered by words and meaning together. The scores stand in for
 * what the embedding worker returns (its own test runs the real model); here
 * the rules are checked: meaning adds to words, admits a conversation only
 * when clearly close, shows the closest message as evidence, and changes
 * nothing when the model isn't running.
 */

const records = [syncBugChat(), storageChoiceChat(), photosynthesisChat()]
const [sync, storage, photo] = records as [(typeof records)[number], (typeof records)[number], (typeof records)[number]]
const index = buildConversationIndex({ records, extractions: new Map(records.map((record) => [record.id, extractConversation(record)])), settings: DEFAULT_INTELLIGENCE_SETTINGS, now: NOW })
const ask = (text: string, semantic?: SemanticHits) => answerQuery(index, parseQuery(text, NOW), semantic ? { semantic } : {})

describe("answering by meaning as well as words", () => {
  const noSharedWord = "What did I learn about turning sunshine into food inside leaves?"

  it("finds nothing by words alone when no word is shared", () => {
    expect(ask(noSharedWord).enough).toBe(false)
  })

  it("finds a clearly close conversation with no shared word, says why, and quotes its closest message", () => {
    const answer = ask(noSharedWord, new Map([[photo.id, { score: 0.55, messageIndex: 1 }]]))
    expect(answer.enough).toBe(true)
    expect(answer.conversations[0]!.record.id).toBe(photo.id)
    expect(answer.conversations[0]!.why).toContain("close in meaning (55%)")
    expect(answer.conversations[0]!.evidence).toMatchObject({ recordId: photo.id, messageIndex: 1, role: "assistant" })
    expect(answer.conversations[0]!.evidence!.quote).toContain("Photosynthesis is the process")
  })

  it("does not admit a loose resemblance on its own", () => {
    const answer = ask(noSharedWord, new Map([[photo.id, { score: RETRIEVAL_CONFIG.semanticMatch - 0.05, messageIndex: 1 }]]))
    expect(answer.enough).toBe(false)
    expect(answer.conversations).toEqual([])
  })

  it("adds closeness to a word match's score, and reorders by it", () => {
    const question = "IndexedDB storage"
    const words = ask(question)
    const both = ask(question, new Map([[storage.id, { score: 0.7, messageIndex: 2 }], [sync.id, { score: 0.21, messageIndex: -1 }]]))
    const score = (answer: ReturnType<typeof ask>, id: string) => answer.conversations.find((entry) => entry.record.id === id)?.score ?? 0
    expect(score(both, storage.id)).toBeCloseTo(score(words, storage.id) + (0.7 - RETRIEVAL_CONFIG.semanticFloor) * RETRIEVAL_CONFIG.semanticWeight, 1)
    expect(score(both, sync.id)).toBeCloseTo(score(words, sync.id) + 0.01 * RETRIEVAL_CONFIG.semanticWeight, 1)
    expect(both.conversations[0]!.record.id).toBe(storage.id)
  })

  it("is exactly the words-only answer when the model isn't running", () => {
    for (const question of ["What did I decide this week?", "IndexedDB storage", noSharedWord, "Which questions are still open?"]) {
      expect(answerQuery(index, parseQuery(question, NOW), {})).toEqual(answerQuery(index, parseQuery(question, NOW)))
      expect(ask(question, new Map())).toEqual(ask(question))
    }
  })
})

describe("reading the question", () => {
  it("asks for tasks when tasks are named, even with “still open”", () => {
    expect(parseQuery("Which tasks are still open?", NOW).focus).toBe("tasks")
    expect(parseQuery("Which questions are still open?", NOW).focus).toBe("questions")
    expect(parseQuery("What is still open?", NOW).focus).toBe("questions")
  })

  it("never matches on pronouns or connectives", () => {
    expect(parseQuery("containers crashing because they run out of RAM", NOW).terms).not.toEqual(expect.arrayContaining(["they"]))
    expect(parseQuery("how did we fix it and why", NOW).terms).toEqual(["fix"])
  })
})
