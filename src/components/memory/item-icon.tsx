"use client"

import { KindGlyph } from "@/components/ui/kind-glyph"
import { ProviderMark } from "@/components/memory/provider-mark"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { itemIdentity } from "@/lib/memory/item-icon"
import { itemKind } from "@/lib/memory/kinds"
import { cn } from "@/lib/utils"
import type { KnowledgeItem } from "@/lib/memory/items"

/**
 * An item's icon in a list row: its AI app's logo, its site's own favicon,
 * or its kind's glyph (see lib/memory/item-icon.ts for which, and why).
 *
 * Always the same `size` box whatever is inside it, so a favicon resolving
 * late — or never — cannot move the row. While a site's icon is on its way,
 * and if it never comes, the kind's glyph holds the place: quiet, in the
 * row's own colours, no badge behind it.
 *
 * `tile` draws it on the bordered square the inspector and the Continue card
 * use for their larger icon.
 */
export function ItemIcon({
  item,
  favicon,
  size = 16,
  tile = false,
  className,
}: {
  item: Pick<KnowledgeItem, "type" | "url" | "domain" | "provider" | "fileName" | "ref">
  /** Chrome's own icon for this page (`Tab.favicon`), when the caller holds the tab. */
  favicon?: string
  size?: number
  tile?: boolean
  className?: string
}) {
  const identity = itemIdentity(item, favicon)
  const kind = itemKind(item)
  if (identity.kind === "glyph") return <KindGlyph kind={kind} type={item.type} tile={tile} className={className} />

  const mark =
    identity.kind === "provider" ? (
      <ProviderMark provider={identity.provider} size={size} />
    ) : (
      <TabFavicon domain={identity.host} {...(identity.icon ? { icon: identity.icon } : {})} size={size} fallback={<KindGlyph kind={kind} type={item.type} className="size-full" />} />
    )
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center", tile && "size-8 overflow-hidden rounded-md border border-subtle bg-background", className)}
      style={tile ? undefined : { width: size, height: size }}
      data-item-icon={identity.kind}
    >
      {mark}
    </span>
  )
}
