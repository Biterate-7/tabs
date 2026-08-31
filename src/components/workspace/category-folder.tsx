"use client"

import { useRef, useState, type AnimationEvent, type CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import type { CategoryPresence } from "@/lib/workspace/hierarchy"
import { representativeTabs } from "@/lib/workspace/stats"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { useOptionalAppearanceContext } from "@/components/appearance-provider"
import { useUiSound } from "@/hooks/use-ui-sound"

// Fanned peeking-document layout, indexed by preview slot — deliberately
// asymmetric (not a neat evenly-spaced row) so a stack of "papers" reads as
// physically dropped into a folder rather than laid out by a grid.
const DOC_ROTATE = [-6, 3, -4, 5]
const DOC_OFFSET_X = [-30, -6, 20, 46]

export function CategoryFolder({
  categoryId,
  tabs,
  presence,
  onViewAll,
}: {
  categoryId: CategoryId
  tabs: Tab[]
  presence: CategoryPresence
  onViewAll: () => void
}) {
  const def = CATEGORIES[categoryId]
  const Icon = def.icon
  const isEmpty = tabs.length === 0

  const wrapperRef = useRef<HTMLButtonElement>(null)
  const [isOpening, setIsOpening] = useState(false)
  const appearance = useOptionalAppearanceContext()
  const settings = appearance?.settings
  const prefersReducedMotion = appearance?.prefersReducedMotion ?? false
  const reduced =
    prefersReducedMotion || settings?.motion.level === "off" || settings?.motion.level === "reduced"
  const soundEnabled = settings?.sound.enabled ?? true
  const soundVolume = (settings?.sound.volume ?? 35) / 100
  const sound = useUiSound(soundEnabled)

  if (presence === "compact") {
    return (
      <button
        type="button"
        onClick={isEmpty ? undefined : onViewAll}
        disabled={isEmpty}
        aria-label={
          isEmpty
            ? `${def.name}: no tabs`
            : `View all ${tabs.length} ${def.name} tab${tabs.length === 1 ? "" : "s"}`
        }
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) sm:min-h-0",
          isEmpty ? "cursor-default opacity-45" : "bg-card hover:border-border"
        )}
      >
        <Icon className="size-3.5 shrink-0" style={{ color: `var(${def.accentColor})` }} />
        <span className="text-body-sm text-foreground">{def.name}</span>
        <span className="ml-auto text-meta text-tertiary">{tabs.length}</span>
      </button>
    )
  }

  const previewLimit = presence === "large" ? 4 : 3
  const previewTabs = representativeTabs(tabs, previewLimit)
  const extraCount = Math.max(0, tabs.length - previewTabs.length)

  const handleOpen = () => {
    if (isOpening) return
    setIsOpening(true)
    if (!reduced) sound.zipperOpen(soundVolume)
  }

  const handleAnimationEnd = (event: AnimationEvent<HTMLButtonElement>) => {
    if (event.target !== wrapperRef.current) return
    if (event.animationName === "folder-card-open" || event.animationName === "folder-open-reduced") {
      setIsOpening(false)
      onViewAll()
    }
  }

  return (
    <button
      ref={wrapperRef}
      type="button"
      onClick={handleOpen}
      onAnimationEnd={handleAnimationEnd}
      disabled={isOpening}
      aria-label={`Open ${def.name}, ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`}
      className={cn(
        "group relative block w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
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
      {/* Folder body: back plate + peeking documents + front pocket flap. */}
      <div
        className="relative flex flex-col overflow-hidden rounded-xl border border-subtle bg-card shadow-sm transition-[transform,box-shadow] duration-(--duration-fast) ease-(--ease-standard) group-hover:-translate-y-0.5 group-hover:shadow-md"
        style={{ minHeight: presence === "large" ? 168 : 152 }}
      >
        {/* Accent index tab — the folder's identity color. */}
        <div
          aria-hidden
          className="absolute top-0 left-4 h-2 w-10 rounded-b-sm"
          style={{ backgroundColor: `var(${def.accentColor})`, opacity: 0.6 }}
        />

        {/* Peeking tab-sheet previews, stored inside the folder. */}
        {previewTabs.length > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-4 h-16"
            style={{
              animation:
                isOpening && !reduced ? "folder-docs-reveal var(--duration-folder-open) var(--ease-standard) both" : undefined,
            }}
          >
            {previewTabs.map((tab, i) => (
              <div
                key={tab.id}
                className="absolute w-[74px] rounded-md border border-subtle bg-surface px-1.5 py-1 shadow-sm transition-transform duration-(--duration-fast) ease-(--ease-standard) group-hover:-translate-y-1"
                style={{
                  left: `calc(50% + ${DOC_OFFSET_X[i]}px)`,
                  transform: `translateX(-50%) rotate(${DOC_ROTATE[i]}deg)`,
                  zIndex: i + 1,
                }}
              >
                <div className="flex items-center gap-1">
                  <TabFavicon domain={tab.domain} size={12} />
                  <span className="truncate text-[9px] leading-tight text-foreground">
                    {tab.title?.trim() || tab.domain}
                  </span>
                </div>
              </div>
            ))}
            {extraCount > 0 && (
              <div
                className="absolute w-[74px] rounded-md border border-subtle bg-surface-active px-1.5 py-1 text-center text-[9px] leading-tight text-tertiary shadow-sm transition-transform duration-(--duration-fast) ease-(--ease-standard) group-hover:-translate-y-1"
                style={{
                  left: `calc(50% + ${DOC_OFFSET_X[previewTabs.length] ?? 60}px)`,
                  transform: "translateX(-50%)",
                  zIndex: previewTabs.length + 1,
                }}
              >
                +{extraCount} more
              </div>
            )}
          </div>
        )}

        {/* Front pocket flap — the piece that "unzips" open. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 origin-top rounded-b-xl border-t border-subtle transition-transform duration-(--duration-fast) ease-(--ease-standard) group-hover:[transform:rotateX(-5deg)]"
          style={{
            top: "40%",
            backgroundColor: "var(--surface)",
            backfaceVisibility: "hidden",
            animation:
              isOpening && !reduced ? "folder-flap-open var(--duration-folder-open) var(--ease-standard) both" : undefined,
          }}
        >
          {/* Zipper seam + pull, the signature open interaction. */}
          <svg
            className="absolute -top-[5px] left-2 h-[10px] w-[calc(100%-1rem)]"
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            style={{
              animation: isOpening && !reduced ? "folder-seam-fade var(--duration-folder-open) var(--ease-standard) both" : undefined,
            }}
          >
            <path
              d="M0 5 L4 1 L8 9 L12 1 L16 9 L20 1 L24 9 L28 1 L32 9 L36 1 L40 9 L44 1 L48 9 L52 1 L56 9 L60 1 L64 9 L68 1 L72 9 L76 1 L80 9 L84 1 L88 9 L92 1 L96 9 L100 5"
              stroke="var(--border-strong)"
              strokeWidth="1"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {!reduced && (
            <svg
              className="absolute -top-[7px] left-2 h-[14px] w-[14px]"
              viewBox="0 0 14 14"
              style={
                {
                  "--zip-travel": "calc(100% - 3rem)",
                  animation: isOpening ? "folder-zipper-pull var(--duration-folder-open) var(--ease-standard) both" : undefined,
                } as CSSProperties
              }
            >
              <circle cx="7" cy="7" r="4" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1.4" />
              <rect x="5.5" y="1" width="3" height="4" rx="1" fill="var(--border-strong)" />
            </svg>
          )}
        </div>
      </div>

      {/* Label — stays outside the animated folder body so it never moves
          on hover and reads clearly through every phase of the open sequence. */}
      <div className="mt-3 flex items-center gap-2 px-0.5">
        <Icon className="size-4 shrink-0" style={{ color: `var(${def.accentColor})` }} />
        <span className="text-body font-medium text-foreground">{def.name}</span>
        <span className="ml-auto text-meta text-tertiary">
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </span>
      </div>
    </button>
  )
}
