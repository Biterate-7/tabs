import { KNOWLEDGE_TYPE_LABEL } from "@/lib/memory/items"
import { aiProviderName } from "@/lib/providers/registry"
import { formatRelativeTime } from "@/lib/time-format"
import type { GraphNodeKind, KnowledgeNode } from "@/lib/knowledge-graph/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const NODE_KIND_LABEL: Record<GraphNodeKind, string> = {
  project: "Project",
  conversation: "AI conversation",
  source: "Source",
  file: "File",
  note: "Note",
  session: "Browser session",
}

/** What a node is, in words: "PDF", "AI conversation", "Browser session". */
export function nodeTypeLabel(node: KnowledgeNode): string {
  if (node.kind === "project" || node.kind === "session") return NODE_KIND_LABEL[node.kind]
  if (node.kind === "file") return node.type === "pdf" ? "PDF file" : "File"
  if (node.savedTab) return "Saved tab"
  return node.type ? KNOWLEDGE_TYPE_LABEL[node.type] : NODE_KIND_LABEL[node.kind]
}

/** The facts worth a glance — the hover card's second line, the list's trailing column. */
export function nodeFacts(node: KnowledgeNode, now: number): string[] {
  const facts: string[] = []
  if (node.kind === "project") facts.push(plural(node.size ?? 0, "item", "items"))
  if (node.kind === "session" && node.tabCount !== undefined) facts.push(plural(node.tabCount, "tab", "tabs"))
  if (node.provider) facts.push(aiProviderName(node.provider))
  const item = node.item
  if (item?.turns) facts.push(plural(item.turns, "turn", "turns"))
  if (item?.pages) facts.push(plural(item.pages, "page", "pages"))
  if (item && !item.provider && item.domain && node.kind === "source") facts.push(item.domain)
  if (item?.status === "failed") facts.push("Couldn't read")
  else if (item && (item.status === "pending" || item.status === "processing")) facts.push("Reading…")
  const when = formatRelativeTime(node.at, now)
  if (when) facts.push(when)
  return facts
}

/** One sentence for screen readers when the keyboard lands on a node. */
export function announceNode(node: KnowledgeNode, projectName: string | undefined, connections: number, now: number): string {
  const where = node.kind !== "project" && projectName ? `, in ${projectName}` : ""
  return `${nodeTypeLabel(node)}: ${node.label}${where}. ${nodeFacts(node, now).join(", ")}. ${plural(connections, "connection", "connections")}. Enter opens, Space shows details.`
}
