import type { ResourceContent } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * A sample project for the landing page: two AI conversations (ChatGPT and
 * Claude), a PDF and a note. Fixed data, never stored — the landing page's
 * search and context examples run the product's own code over it
 * (lib/memory/search.ts, lib/memory/bundle.ts), so they show what Hubble
 * actually produces.
 */

const T = Date.UTC(2026, 9, 6, 9, 0, 0)

export const SAMPLE_WORKSPACE: Workspace = {
  id: "sample-history",
  name: "History IA",
  brief: { description: "Why did the First World War start?", focus: "Weigh the alliance system against nationalism", updatedAt: T },
  tabs: [
    {
      id: "chat-gpt",
      url: "https://chatgpt.com/c/0000aaaa-sample",
      normalizedUrl: "chatgpt.com/c/0000aaaa-sample",
      domain: "chatgpt.com",
      title: "Causes of WW1",
      createdAt: T,
      resource: {
        kind: "conversation",
        origin: "extension",
        status: "ready",
        addedAt: T,
        updatedAt: T,
        meta: { provider: "chatgpt", turnCount: 4, capture: "page", contentHash: "0000000000000001" },
        content: { chars: 900, turns: 4, extractedAt: T },
      },
    },
    {
      id: "chat-claude",
      url: "https://claude.ai/chat/0000bbbb-sample",
      normalizedUrl: "claude.ai/chat/0000bbbb-sample",
      domain: "claude.ai",
      title: "Was the alliance system to blame?",
      createdAt: T + 86_400_000,
      resource: {
        kind: "conversation",
        origin: "extension",
        status: "ready",
        addedAt: T + 86_400_000,
        updatedAt: T + 86_400_000,
        meta: { provider: "claude", turnCount: 2, capture: "page", contentHash: "0000000000000002" },
        content: { chars: 700, turns: 2, extractedAt: T + 86_400_000 },
      },
    },
    {
      id: "pdf-clark",
      url: "https://example.edu/readings/july-crisis.pdf",
      normalizedUrl: "example.edu/readings/july-crisis.pdf",
      domain: "example.edu",
      title: "The July Crisis (course reading)",
      createdAt: T + 2 * 86_400_000,
      resource: {
        kind: "pdf",
        origin: "chrome",
        status: "ready",
        addedAt: T + 2 * 86_400_000,
        updatedAt: T + 2 * 86_400_000,
        content: { chars: 400, pages: 2, extractedAt: T + 2 * 86_400_000 },
      },
    },
  ],
  notes: [
    {
      id: "note-thesis",
      kind: "note",
      title: "My working thesis",
      origin: "manual",
      createdAt: T + 3 * 86_400_000,
      updatedAt: T + 3 * 86_400_000,
      contentHash: "0000000000000003",
      chars: 160,
    },
  ],
  createdAt: T,
  updatedAt: T + 3 * 86_400_000,
}

export const SAMPLE_CONTENTS: ReadonlyMap<string, ResourceContent> = new Map<string, ResourceContent>([
  [
    "chat-gpt",
    {
      kind: "conversation",
      extractedAt: T,
      turns: [
        { role: "user", text: "What were the main causes of the First World War?" },
        { role: "assistant", text: "Historians usually group them as militarism, alliances, imperialism and nationalism. The alliance system turned a regional crisis in the Balkans into a continental war within weeks." },
        { role: "user", text: "Which one mattered most?" },
        { role: "assistant", text: "Many textbooks stress the alliance system, but some historians argue nationalism in the Balkans was the deeper cause." },
      ],
    },
  ],
  [
    "chat-claude",
    {
      kind: "conversation",
      extractedAt: T + 86_400_000,
      turns: [
        { role: "user", text: "Was the alliance system really to blame for the war?" },
        { role: "assistant", text: "Less than often claimed: the alliances were defensive and loosely binding. Italy stayed out in 1914 despite its treaty. Decisions taken in Vienna and Berlin during the July Crisis mattered more." },
      ],
    },
  ],
  [
    "pdf-clark",
    {
      kind: "pdf",
      extractedAt: T + 2 * 86_400_000,
      pages: [
        "The July Crisis of 1914 unfolded over five weeks after the assassination in Sarajevo.",
        "Austria-Hungary's ultimatum to Serbia, backed by Germany, turned a regional dispute into a general war; the alliance system shaped who joined, not whether war came.",
      ],
    },
  ],
  ["note-thesis", { kind: "note", extractedAt: T + 3 * 86_400_000, text: "The alliance system explains how the war spread, not why it began. Focus the essay on decisions during the July Crisis." }],
])
