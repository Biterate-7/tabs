import { parseSingleUrl } from "@/lib/tabs/parse"
import { readActivityRecord } from "../records"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"
import type { ActivityRecord } from "../types"

/**
 * Realistic student work for the engine's deterministic tests. Titles are
 * the kind Chrome reports; conversation "terms" are what the extension's
 * conversationTerms keeps from a read conversation (topic words, never text).
 * Times are fixed so no result depends on the clock.
 */

export const NOW = Date.UTC(2026, 9, 28, 15, 0, 0)
export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

const dayOf = (ms: number) => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

type PageInput = {
  url: string
  title: string
  at?: number
  /** Extra days it was used on, as offsets before `at`. */
  alsoDaysAgo?: number[]
  dwellMs?: number
  visits?: number
  terms?: string[]
  partial?: boolean
}

export function page(input: PageInput): ActivityRecord {
  const at = input.at ?? NOW - HOUR
  const days = [...(input.alsoDaysAgo ?? []).map((ago) => dayOf(at - ago * DAY)), dayOf(at)]
  const read = input.terms !== undefined
  const record = readActivityRecord({
    url: input.url,
    title: input.title,
    firstSeenAt: at - Math.max(...(input.alsoDaysAgo ?? [0]), 0) * DAY - 10 * 60 * 1000,
    lastSeenAt: at,
    visits: input.visits ?? 1,
    dwellMs: input.dwellMs ?? 5 * 60 * 1000,
    days,
    open: true,
    kind: /chatgpt|claude\.ai|gemini|perplexity/.test(input.url) ? "conversation" : /docs\.google/.test(input.url) ? "document" : "article",
    capture: read
      ? { status: input.partial ? "partial" : "content", method: "page-read", readAt: at, attemptedAt: at, turnCount: 12, contentHash: "fnv1a:00000000:1" }
      : { status: "metadata", method: "tab-metadata" },
    ...(read ? { terms: input.terms } : {}),
  })
  if (!record) throw new Error(`fixture page refused: ${input.url}`)
  return record
}

export const source = (url: string, title: string): Tab => ({
  ...parseSingleUrl(url)!,
  id: `saved-${url}`,
  createdAt: NOW - 5 * DAY,
  updatedAt: NOW - 5 * DAY,
  title,
  resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY },
})

export function project(id: string, name: string, tabs: Tab[] = [], updatedAt = NOW - 2 * DAY): Workspace {
  return { id, name, tabs, sections: [], createdAt: NOW - 30 * DAY, updatedAt }
}

// ---------------------------------------------------------------- Case A: one Economics IA

export const economicsChat = page({
  url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001",
  title: "Sugar tax effectiveness",
  terms: ["sugar", "tax", "taxes", "externality", "externalities", "consumption", "elasticity", "demand", "price", "market", "failure", "government", "revenue", "obesity", "health", "indirect", "economics", "evaluation"],
  dwellMs: 25 * 60 * 1000,
})
export const economicsArticles = [
  page({ url: "https://www.economicshelp.org/blog/sugar-tax-externalities/", title: "Sugar taxes and negative externalities - Economics Help" }),
  page({ url: "https://www.brookings.edu/articles/do-soda-taxes-work/", title: "Do soda and sugar taxes work? Evidence on consumption | Brookings" }),
  page({ url: "https://www.tutor2u.net/economics/reference/indirect-taxes-and-market-failure", title: "Indirect taxes and market failure | tutor2u" }),
]
export const economicsDraft = page({ url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit", title: "Economics IA – Sugar tax draft - Google Docs", dwellMs: 40 * 60 * 1000 })

// ---------------------------------------------------------------- Case B: maths homework in the same hour

export const mathsChat = page({
  url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000002",
  title: "Chain rule derivatives help",
  terms: ["derivative", "derivatives", "chain", "rule", "function", "composite", "differentiate", "differentiation", "calculus", "tangent", "gradient", "inner", "outer"],
  dwellMs: 15 * 60 * 1000,
})
export const mathsPages = [
  page({ url: "https://www.khanacademy.org/math/ap-calculus-ab/chain-rule", title: "Chain rule: derivatives of composite functions | Khan Academy" }),
  page({ url: "https://www.mathsisfun.com/calculus/derivatives-rules.html", title: "Derivative rules and the chain rule" }),
]

// ---------------------------------------------------------------- Case C: something personal

export const personalChat = page({
  url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000003",
  title: "Easy sourdough pizza dough recipe",
  terms: ["dough", "flour", "yeast", "pizza", "sourdough", "oven", "bake", "recipe", "hydration", "starter", "knead"],
  dwellMs: 10 * 60 * 1000,
})

// ---------------------------------------------------------------- Case E: generic pages

export const genericPages = [
  page({ url: "https://www.bbc.co.uk/news", title: "Home - BBC News" }),
  page({ url: "https://weather.com/weather/today", title: "Weather Forecast and Conditions" }),
  page({ url: "https://www.amazon.co.uk/gp/bestsellers", title: "Amazon.co.uk Best Sellers" }),
  page({ url: "https://www.reddit.com/r/popular/", title: "Popular posts on Reddit" }),
]
