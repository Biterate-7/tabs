import type { ResourceContent } from "@/lib/resources/types"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * A sample project for the landing page: AI conversations from all four
 * apps Hubble saves from, a PDF, a web page, a lecture video and a note.
 * Fixed data, never stored — the page's search and context examples run the
 * product's own code over it (lib/memory/search.ts, lib/memory/bundle.ts,
 * lib/memory/items.ts), so they show what Hubble actually produces.
 *
 * Addresses are placeholders on reserved or sample paths, so nothing on the
 * page points at a real person's conversation.
 */

const T = Date.UTC(2026, 9, 6, 9, 0, 0)
const DAY = 86_400_000

function conversation(id: string, url: string, title: string, provider: "chatgpt" | "claude" | "gemini" | "perplexity", at: number, turns: number, hash: string): Tab {
  const host = new URL(url).host
  return {
    id,
    url,
    normalizedUrl: url.replace(/^https:\/\//, ""),
    domain: host,
    title,
    createdAt: at,
    resource: {
      kind: "conversation",
      origin: "extension",
      status: "ready",
      addedAt: at,
      updatedAt: at,
      meta: { provider, turnCount: turns, capture: "page", contentHash: hash },
      content: { chars: 700, turns, extractedAt: at },
    },
  }
}

export const SAMPLE_WORKSPACE: Workspace = {
  id: "sample-history",
  name: "History IA",
  brief: { description: "Why did the First World War start?", focus: "Weigh the alliance system against nationalism", updatedAt: T },
  tabs: [
    conversation("chat-gpt", "https://chatgpt.com/c/0000aaaa-sample", "Causes of WW1", "chatgpt", T, 4, "0000000000000001"),
    conversation("chat-claude", "https://claude.ai/chat/0000bbbb-sample", "Was the alliance system to blame?", "claude", T + DAY, 2, "0000000000000002"),
    {
      id: "pdf-clark",
      url: "https://example.edu/readings/july-crisis.pdf",
      normalizedUrl: "example.edu/readings/july-crisis.pdf",
      domain: "example.edu",
      title: "The July Crisis (course reading)",
      createdAt: T + 2 * DAY,
      resource: {
        kind: "pdf",
        origin: "chrome",
        status: "ready",
        addedAt: T + 2 * DAY,
        updatedAt: T + 2 * DAY,
        content: { chars: 400, pages: 2, extractedAt: T + 2 * DAY },
      },
    },
    conversation("chat-gemini", "https://gemini.google.com/app/0000cccc-sample", "Timeline of the July Crisis", "gemini", T + 3 * DAY, 2, "0000000000000004"),
    {
      id: "page-sarajevo",
      url: "https://example.org/history/sarajevo-1914",
      normalizedUrl: "example.org/history/sarajevo-1914",
      domain: "example.org",
      title: "Sarajevo, 28 June 1914",
      createdAt: T + 3 * DAY + 3_600_000,
      resource: {
        kind: "webpage",
        origin: "chrome",
        status: "ready",
        addedAt: T + 3 * DAY + 3_600_000,
        updatedAt: T + 3 * DAY + 3_600_000,
        content: { chars: 300, extractedAt: T + 3 * DAY + 3_600_000 },
      },
    },
    conversation("chat-perplexity", "https://www.perplexity.ai/search/0000dddd-sample", "Did Italy's neutrality matter?", "perplexity", T + 4 * DAY, 2, "0000000000000005"),
  ],
  notes: [
    {
      id: "note-thesis",
      kind: "note",
      title: "My working thesis",
      origin: "manual",
      createdAt: T + 5 * DAY,
      updatedAt: T + 5 * DAY,
      contentHash: "0000000000000003",
      chars: 160,
    },
  ],
  createdAt: T,
  updatedAt: T + 5 * DAY,
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
      extractedAt: T + DAY,
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
      extractedAt: T + 2 * DAY,
      pages: [
        "The July Crisis of 1914 unfolded over five weeks after the assassination in Sarajevo.",
        "Austria-Hungary's ultimatum to Serbia, backed by Germany, turned a regional dispute into a general war; the alliance system shaped who joined, not whether war came.",
      ],
    },
  ],
  [
    "chat-gemini",
    {
      kind: "conversation",
      extractedAt: T + 3 * DAY,
      turns: [
        { role: "user", text: "Give me a timeline of the July Crisis." },
        { role: "assistant", text: "28 June: the assassination in Sarajevo. 5 July: Germany's 'blank cheque' to Austria-Hungary. 23 July: the ultimatum to Serbia. 28 July: Austria-Hungary declares war. 1–4 August: Germany, Russia, France and Britain follow." },
      ],
    },
  ],
  [
    "page-sarajevo",
    {
      kind: "webpage",
      extractedAt: T + 3 * DAY + 3_600_000,
      text: "On 28 June 1914 Archduke Franz Ferdinand was shot in Sarajevo by Gavrilo Princip, a Bosnian Serb nationalist. The assassination set off the July Crisis.",
    },
  ],
  [
    "chat-perplexity",
    {
      kind: "conversation",
      extractedAt: T + 4 * DAY,
      turns: [
        { role: "user", text: "Did Italy's neutrality in 1914 matter?" },
        { role: "assistant", text: "It shows the limits of the alliance system: Italy was bound to Germany and Austria-Hungary on paper, yet declared neutrality in August 1914 and later joined the other side." },
      ],
    },
  ],
  ["note-thesis", { kind: "note", extractedAt: T + 5 * DAY, text: "The alliance system explains how the war spread, not why it began. Focus the essay on decisions during the July Crisis." }],
])

/** The sample's content keyed by project, the shape `searchKnowledge` takes. */
export const SAMPLE_CONTENT_MAP: ReadonlyMap<string, ReadonlyMap<string, ResourceContent>> = new Map([[SAMPLE_WORKSPACE.id, SAMPLE_CONTENTS]])
