import { FileText, Globe, Layers, Link2, MessagesSquare, NotebookPen, PlayCircle, Quote, FileType2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { KnowledgeItemType } from "@/lib/memory/items"
import type { ItemKind } from "@/lib/memory/kinds"

/** A glyph for each thing's own type. */
const TYPE_ICON: Record<KnowledgeItemType, LucideIcon> = {
  conversation: MessagesSquare,
  webpage: Globe,
  pdf: FileText,
  video: PlayCircle,
  document: FileType2,
  link: Link2,
  note: NotebookPen,
  excerpt: Quote,
}

const KIND_ICON: Record<ItemKind | "session", LucideIcon> = {
  conversation: MessagesSquare,
  source: Globe,
  file: FileText,
  note: NotebookPen,
  session: Layers,
}

/**
 * The kinds' identity colours are for data — the graph's nodes, the legend
 * dots, the mix bar — where colour tells things apart. They are not for
 * icons: an icon beside a label takes the label's own colour.
 */
export const KIND_TEXT_CLASS: Record<ItemKind | "session", string> = {
  conversation: "text-kind-conversation",
  source: "text-kind-source",
  file: "text-kind-file",
  note: "text-kind-note",
  session: "text-kind-session",
}

export const KIND_BG_CLASS: Record<ItemKind | "session", string> = {
  conversation: "bg-kind-conversation",
  source: "bg-kind-source",
  file: "bg-kind-file",
  note: "bg-kind-note",
  session: "bg-kind-session",
}

/**
 * The icon a thing is known by, as a plain outline glyph in muted ink. `kind`
 * picks the glyph; `type` (when given) picks the more specific one — a video
 * is a source, drawn as a play mark. Decorative: the thing's kind is always
 * also said in words beside it. `tile` only reserves the 32px square that
 * favicon and provider icons occupy in the same slot, so rows stay aligned.
 */
export function KindGlyph({ kind, type, className, tile = false }: { kind: ItemKind | "session"; type?: KnowledgeItemType; className?: string; tile?: boolean }) {
  const Icon = type ? TYPE_ICON[type] : KIND_ICON[kind]
  if (!tile) return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />
  return (
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center", className)}>
      <Icon className="size-4 text-muted-foreground" />
    </span>
  )
}
