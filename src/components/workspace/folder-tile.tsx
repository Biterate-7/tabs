"use client"

import { useRef, useState, type AnimationEvent, type DragEvent } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Tab } from "@/lib/tabs/types"
import { representativeTabs } from "@/lib/workspace/stats"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { useOptionalAppearanceContext } from "@/components/appearance-provider"
import { useUiSound } from "@/hooks/use-ui-sound"
import { getDragTabId, hasDragTabId } from "@/lib/collections/drag"

export type FolderPresence = "large" | "standard" | "compact"

/**
 * Shared tile presentation for both flat categories (CategoryFolder) and
 * hierarchical sections (SectionFolder): a quiet surface listing what is
 * inside, opening to whatever view the caller provides (CategoryPage /
 * SectionPage).
 *
 * Kept presentational: identity (name/icon/accent/tabs) and the open
 * callback are the only per-caller inputs, so both card types stay visually
 * and behaviorally in sync.
 *
 * It was a folder *illustration* until this pass — see the note on the card
 * body below for what changed and why.
 */
export function FolderTile({
  name,
  icon: Icon,
  accentVar,
  tabs,
  totalCount,
  subtitle,
  presence,
  onOpen,
  onDropTab,
}: {
  name: string
  icon: LucideIcon
  accentVar: string
  tabs: Tab[]
  totalCount: number
  /** Optional secondary meta line under the name — e.g. "3 subsections". */
  subtitle?: string
  presence: FolderPresence
  onOpen: () => void
  /** Omitted for tiles that aren't valid drop targets (e.g. the synthetic "Other" section). */
  onDropTab?: (tabId: string) => void
}) {
  const isEmpty = totalCount === 0

  const wrapperRef = useRef<HTMLButtonElement>(null)
  const [isOpening, setIsOpening] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const appearance = useOptionalAppearanceContext()
  const settings = appearance?.settings
  const prefersReducedMotion = appearance?.prefersReducedMotion ?? false
  const reduced =
    prefersReducedMotion || settings?.motion.level === "off" || settings?.motion.level === "reduced"
  const soundEnabled = settings?.sound.enabled ?? true
  const soundVolume = (settings?.sound.volume ?? 35) / 100
  const sound = useUiSound(soundEnabled)

  function handleDragOver(e: DragEvent<HTMLButtonElement>) {
    if (!onDropTab || !hasDragTabId(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    if (!dragOver) setDragOver(true)
  }

  function handleDragLeave(e: DragEvent<HTMLButtonElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }

  function handleDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragOver(false)
    const tabId = getDragTabId(e.dataTransfer)
    if (tabId && onDropTab) onDropTab(tabId)
  }

  if (presence === "compact") {
    return (
      <button
        type="button"
        onClick={isEmpty ? undefined : onOpen}
        disabled={isEmpty}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-label={isEmpty ? `${name}: no tabs` : `Open ${name}, ${totalCount} tab${totalCount === 1 ? "" : "s"}`}
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-xs bg-card px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-color) sm:min-h-8",
          isEmpty ? "cursor-default opacity-45" : "hover:bg-surface-hover",
          dragOver && "bg-link/[0.06] ring-1 ring-link/40"
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" data-accent={accentVar} />
        <span className="text-body-sm text-foreground">{name}</span>
        <span className="ml-auto text-meta text-tertiary">{totalCount}</span>
      </button>
    )
  }

  // Four rows fit the standard tile without it growing; the large tile has
  // the height for one more. Both are up from 3/4 *scraps* — the rows are
  // legible now, so more of them is more information rather than more noise.
  const previewLimit = presence === "large" ? 5 : 4
  const previewTabs = representativeTabs(tabs, previewLimit)
  const extraCount = Math.max(0, totalCount - previewTabs.length)

  const handleOpen = () => {
    if (isOpening) return
    setIsOpening(true)
    if (!reduced) sound.folderOpen(soundVolume)
  }

  const handleAnimationEnd = (event: AnimationEvent<HTMLButtonElement>) => {
    if (event.target !== wrapperRef.current) return
    if (event.animationName === "folder-card-open" || event.animationName === "folder-open-reduced") {
      setIsOpening(false)
      onOpen()
    }
  }

  return (
    <button
      ref={wrapperRef}
      type="button"
      onClick={handleOpen}
      onAnimationEnd={handleAnimationEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      disabled={isOpening}
      aria-label={`Open ${name}, ${totalCount} tab${totalCount === 1 ? "" : "s"}`}
      className={cn(
        // flex, not block: a button centres its content vertically, which
        // would float a shorter card in the middle of a taller grid row.
        "group relative flex h-full w-full cursor-pointer flex-col rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        presence === "large" && "sm:col-span-2 lg:col-span-1"
      )}
      style={{
        perspective: "1400px",
        willChange: isOpening ? "transform, opacity, filter" : undefined,
        ...(isOpening
          ? {
              animation: reduced
                ? "folder-open-reduced 140ms var(--ease-standard) both"
                : "folder-card-open var(--duration-folder-open) var(--ease-standard) both",
            }
          : {}),
      }}
    >
      {/*
        The card body: what is actually in this folder.

        What used to be here was a folder *illustration* — a back plate, four
        paper scraps rotated at angles under a pocket flap, and a zipper seam
        with a pull that ran along it on open. It was the most distinctive
        thing on the workspace screen and it communicated almost nothing:
        roughly sixty percent of a 152px card was an empty flap, the "papers"
        carried titles at 9px (about 6.75pt, under the 10pt macOS minimum in
        `accessibility.md`), and a folder of research papers and a folder of
        news were indistinguishable below the favicon row.

        Two things made it worth replacing rather than tidying. Apple's Craft
        and Delight principles draw the line exactly here — "don't mistake
        delight for decoration" — and the skill's craft lens asks what can be
        removed without loss; a pocket flap answers that question by itself.
        And it was the single biggest reason the product read as a different
        design system from the landing page, which is flat, hairline-ruled and
        has no skeuomorphism anywhere in it.

        Everything the tile *did* is intact: it is still one button, still a
        drop target, still opens with the same animation and the same sound,
        still previews representative tabs and still says how many more there
        are. The previews are simply legible now.
      */}
      <div
        className={cn(
          /*
            The reference's card: the card tone on the page, a 4px corner, no
            border and no lift — hover is a one-step tonal change. Title and
            count sit inside at the top, the contents below, so the card reads
            as one object rather than a picture with a caption.
          */
          "relative flex flex-1 flex-col overflow-hidden rounded-xs bg-card px-4 pt-3.5 pb-3",
          "transition-[background-color,box-shadow] duration-(--duration-fast) ease-(--ease-color)",
          "group-hover:bg-surface-hover",
          dragOver && "bg-link/[0.06] ring-1 ring-link/40"
        )}
        style={{ minHeight: presence === "large" ? 184 : 168 }}
      >
        <div className="flex items-baseline gap-2">
          <Icon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" data-accent={accentVar} />
          <span className="truncate text-body font-medium text-foreground">{name}</span>
          <span className="ml-auto shrink-0 text-meta text-tertiary">
            {totalCount} tab{totalCount === 1 ? "" : "s"}
          </span>
        </div>
        {subtitle && <p className="mt-0.5 pl-5.5 text-meta text-tertiary">{subtitle}</p>}

        {previewTabs.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {previewTabs.map((tab) => (
              <span key={tab.id} className="flex min-w-0 items-center gap-2">
                <TabFavicon domain={tab.domain} size={14} />
                <span className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground">
                  {tab.title?.trim() || tab.domain}
                </span>
              </span>
            ))}
            {extraCount > 0 && <span className="text-meta text-tertiary">+{extraCount} more</span>}
          </div>
        ) : (
          /* An empty folder says so plainly: the next action is a drag. */
          <span className="flex flex-1 items-center justify-center px-3 text-center text-body-sm text-tertiary">
            {dragOver ? "Drop to file here" : "Nothing filed here yet"}
          </span>
        )}
      </div>
    </button>
  )
}
