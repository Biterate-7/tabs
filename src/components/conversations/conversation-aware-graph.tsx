"use client"

import { useMemo } from "react"
import { KnowledgeGraphView } from "@/components/knowledge-graph/knowledge-graph-view"
import { useConversationIntelligence } from "@/hooks/use-conversation-intelligence"
import { refKey } from "@/lib/memory/items"
import type { KnowledgeGraphViewProps } from "@/components/knowledge-graph/knowledge-graph-view"
import type { ConversationLink } from "@/lib/knowledge-graph/types"

/** The most inferred relationships the graph draws; the strongest are kept. */
const MAX_LINKS = 300

/**
 * The Graph, with conversations Hubble found to be about the same work
 * joined by an inferred, labelled relationship. Everything else is the
 * Graph exactly as it is: inferred edges never move a node and are drawn
 * only around the conversation in focus.
 */
export function ConversationAwareGraph(props: KnowledgeGraphViewProps) {
  const { index } = useConversationIntelligence(props.workspaces as KnowledgeGraphViewProps["workspaces"], props.now)
  // Relations come from the corpus stage, so a correction or dismissed insight never rebuilds the graph.
  const { relations, records } = index
  const conversationLinks = useMemo<ConversationLink[]>(() => {
    const byId = new Map(records.map((record) => [record.id, record]))
    const out: ConversationLink[] = []
    for (const relation of [...relations].sort((a, b) => b.score - a.score)) {
      // A name in common is not a relationship worth drawing.
      if (relation.sameConversation || relation.level === "shared-entity") continue
      const a = byId.get(relation.a)
      const b = byId.get(relation.b)
      if (!a || !b) continue
      out.push({ a: { workspaceId: a.workspaceId, key: refKey(a.ref) }, b: { workspaceId: b.workspaceId, key: refKey(b.ref) }, score: relation.score, shared: [...relation.sharedEntities, ...relation.sharedTerms].slice(0, 6) })
      if (out.length >= MAX_LINKS) break
    }
    return out
  }, [relations, records])
  return <KnowledgeGraphView {...props} conversationLinks={conversationLinks} />
}
