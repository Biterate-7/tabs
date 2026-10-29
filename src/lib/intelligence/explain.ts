import type { ActivityRecord, Evidence, Suggestion } from "./types"

/**
 * Every sentence a suggestion shows, built only from its evidence: the words
 * the pages actually share, the project's actual name, the actual number of
 * days. Nothing here can say more than the engine found — no "Hubble thinks",
 * no invented reason.
 */

const MAX_NAME = 48

function quote(words: readonly string[]): string {
  // Lower case, as in a sentence; an acronym ("UK", "GDP") keeps its capitals.
  const quoted = words.map((word) => `“${/^[A-Z0-9]{2,5}$/.test(word) ? word : word.toLowerCase()}”`)
  if (quoted.length <= 1) return quoted[0] ?? ""
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`
}

/** A new project's name, from the words its pages share (first-letter capitalised, the way titles spell them). */
export function nameFromWords(words: readonly string[]): string {
  const picked = words.slice(0, 3)
  if (picked.length === 0) return "New project"
  // Sentence case; an acronym ("UK", "GDP") keeps its capitals.
  const cased = picked.map((word, index) => (/^[A-Z0-9]{2,5}$/.test(word) ? word : index === 0 ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()))
  return cased.join(" ").slice(0, MAX_NAME)
}

function what(records: readonly Pick<ActivityRecord, "kind">[]): string {
  const conversations = records.filter((record) => record.kind === "conversation").length
  const others = records.length - conversations
  if (records.length === 1) return conversations === 1 ? "this conversation" : "this page"
  if (others === 0) return `${records.length} conversations`
  if (conversations === 0) return `${records.length} pages`
  return `${conversations === 1 ? "a conversation" : `${conversations} conversations`} and ${others === 1 ? "a page" : `${others} pages`}`
}

export function headlineFor(suggestion: Pick<Suggestion, "kind" | "destination">, records: readonly Pick<ActivityRecord, "kind">[], projectName: string | undefined): string {
  if (suggestion.kind === "save-to-project") {
    const subject = what(records)
    return `Save ${subject} to ${projectName ?? "this project"}?`
  }
  const name = suggestion.destination.kind === "new-project" ? suggestion.destination.name : (projectName ?? "a project")
  return `Start a project for “${name}”?`
}

export function explanationFor(suggestion: Pick<Suggestion, "kind" | "evidence">, projectName: string | undefined, count: number): string {
  const evidence: Evidence = suggestion.evidence
  const words = quote(evidence.sharedTerms.slice(0, 3))
  const source = evidence.fromContent ? "Their titles and text" : count === 1 ? "Its title" : "Their titles"
  const singular = count === 1 && !evidence.fromContent
  const parts: string[] = []
  if (suggestion.kind === "save-to-project") {
    if (evidence.nameTerms.length > 0 && words) parts.push(`${source} ${singular ? "mentions" : "mention"} ${words}, like your project ${projectName ?? ""}`.trim())
    else if (words) parts.push(`${source} ${singular ? "shares" : "share"} ${words} with ${projectName ?? "this project"}`)
    if (evidence.temporal >= 0.5) parts.push(count === 1 ? "You used it while working on the project" : "You used them while working on the project")
  } else {
    if (words) parts.push(`${source} all mention ${words}`)
    if (evidence.days >= 2) parts.push(`across ${evidence.days} days`)
  }
  const sentence = parts.join(suggestion.kind === "create-project" ? " " : ". ")
  return sentence ? `${sentence}.` : ""
}
