"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Search, X } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { DEMO_SECTIONS, DEMO_UNIQUE_TABS } from "./data"
import { useInView, useReducedMotion } from "./hooks"
import { DemoFavicon, DemoWindow } from "./primitives"

/**
 * Search, as a real input over the real corpus.
 *
 * Nothing here is staged: the field is an uncontrolled-feeling controlled
 * input, the filter is a plain substring match across the fields the app
 * actually searches (title, domain, section, subsection), and the count is
 * `matches.length`. Type anything — including something with no hits — and
 * the demo tells the truth about it.
 *
 * Non-matching tabs are dimmed rather than unmounted, and empty sections
 * collapse to nothing. That is the "workspace narrowing around the results"
 * reading: you can still see the shape of everything you own while looking at
 * the handful that matter.
 */

const SUGGESTIONS = ["quantum", "github", "physics", "design"] as const

/** The query the demo types for you on arrival, if you haven't typed first. */
const DEMO_QUERY = "quantum"

function matches(tab: (typeof DEMO_UNIQUE_TABS)[number], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    tab.title.toLowerCase().includes(q) ||
    tab.domain.toLowerCase().includes(q) ||
    tab.section.toLowerCase().includes(q) ||
    tab.subsection.toLowerCase().includes(q)
  )
}

export function SearchDemo() {
  const [query, setQuery] = useState("")
  const [touched, setTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const reduced = useReducedMotion()
  const { ref, shown } = useInView<HTMLDivElement>({ threshold: 0.45 })

  // Types the demo query one character at a time on first arrival. It backs
  // off the moment the visitor touches the field — an autoplay that fights
  // the user for their own input is the worst thing this page could do.
  useEffect(() => {
    if (!shown || touched) return
    if (reduced) {
      // Same reason as the other self-playing demos: the typed query is the
      // finished state, applied at once instead of animated.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery(DEMO_QUERY)
      return
    }
    let i = 0
    const timers: ReturnType<typeof setTimeout>[] = []
    const step = () => {
      i += 1
      setQuery(DEMO_QUERY.slice(0, i))
      if (i < DEMO_QUERY.length) timers.push(setTimeout(step, 105))
    }
    timers.push(setTimeout(step, 520))
    return () => timers.forEach(clearTimeout)
  }, [shown, touched, reduced])

  const result = useMemo(() => {
    const hits = DEMO_UNIQUE_TABS.filter((t) => matches(t, query))
    const hitIds = new Set(hits.map((t) => t.id))
    return { count: hits.length, hitIds }
  }, [query])

  const searching = query.trim().length > 0

  function update(next: string) {
    setTouched(true)
    setQuery(next)
  }

  return (
    <div ref={ref}>
      <DemoWindow
        title="Thesis"
        label="Interactive demonstration: searching a TabDump workspace"
        toolbar={
          <span className="m-num text-[0.6875rem] text-tertiary">
            {searching ? `${result.count} result${result.count === 1 ? "" : "s"}` : `${DEMO_UNIQUE_TABS.length} tabs`}
          </span>
        }
      >
        <div className="border-b border-subtle p-3">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => update(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") update("")
              }}
              placeholder="Search your workspace…"
              aria-label="Search this demo workspace"
              className="h-10 w-full rounded-lg border border-subtle bg-card pr-10 pl-9 text-body-sm text-foreground placeholder:text-tertiary focus-visible:border-[color-mix(in_oklch,var(--primary),transparent_50%)] focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
            />
            {searching && (
              <button
                type="button"
                onClick={() => {
                  update("")
                  inputRef.current?.focus()
                }}
                aria-label="Clear search"
                className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-tertiary hover:bg-white/[0.06] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-meta text-tertiary">Try</span>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  update(s)
                  inputRef.current?.focus()
                }}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[0.6875rem] transition-colors duration-(--duration-fast)",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  query === s
                    ? "border-[color-mix(in_oklch,var(--primary),transparent_50%)] bg-accent-subtle text-foreground"
                    : "border-subtle text-muted-foreground hover:border-strong hover:text-foreground"
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Fixed height with internal scroll: the panel must not resize as the
            result set changes, or every section under it would jump. */}
        <div className="h-[22rem] overflow-y-auto p-3">
          <div className="flex flex-col gap-2">
            {DEMO_SECTIONS.map((section) => {
              const tabs = DEMO_UNIQUE_TABS.filter((t) => t.section === section.name)
              const hits = tabs.filter((t) => result.hitIds.has(t.id))
              const empty = searching && hits.length === 0
              return (
                <div
                  key={section.name}
                  className="grid transition-[grid-template-rows,opacity] duration-(--duration-slow) ease-(--ease-standard)"
                  style={{ gridTemplateRows: empty ? "0fr" : "1fr", opacity: empty ? 0 : 1 }}
                >
                  <div className="overflow-hidden">
                    <div className="m-panel mb-0.5 p-2">
                      <div className="flex items-center gap-2 px-0.5 pb-1.5">
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: `var(${CATEGORIES[section.category].accentColor})` }}
                        />
                        <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-foreground">
                          {section.name}
                        </span>
                        <span className="m-num shrink-0 text-[0.6875rem] text-tertiary">
                          {searching ? `${hits.length}/${tabs.length}` : tabs.length}
                        </span>
                      </div>

                      <div className="flex flex-col gap-1">
                        {tabs.map((tab) => {
                          const hit = result.hitIds.has(tab.id)
                          return (
                            <div
                              key={tab.id}
                              className={cn(
                                "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-[opacity,border-color,background-color] duration-(--duration-base) ease-(--ease-standard)",
                                searching && hit
                                  ? "border-[color-mix(in_oklch,var(--primary),transparent_55%)] bg-accent-subtle"
                                  : "border-subtle bg-card/60"
                              )}
                              style={{ opacity: searching && !hit ? 0.22 : 1 }}
                            >
                              <DemoFavicon domain={tab.domain} size={14} />
                              <span className="min-w-0 flex-1 truncate text-[0.75rem] leading-4 text-muted-foreground">
                                {tab.title}
                              </span>
                              <span className="hidden shrink-0 text-meta text-tertiary sm:block">{tab.subsection}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {searching && result.count === 0 && (
            <p className="px-1 py-6 text-center text-body-sm text-tertiary">
              Nothing matches &ldquo;{query}&rdquo; — in a real workspace, that is the answer you want in one keystroke.
            </p>
          )}
        </div>

        <div className="border-t border-subtle px-3.5 py-3">
          <p className="text-body-sm text-tertiary" aria-live="polite">
            {searching ? (
              <>
                <span className="m-num text-foreground">{result.count}</span> of{" "}
                <span className="m-num">{DEMO_UNIQUE_TABS.length}</span> tabs match &ldquo;
                <span className="text-foreground">{query}</span>&rdquo;
              </>
            ) : (
              "Type anything. It searches titles, domains and sections at once."
            )}
          </p>
        </div>
      </DemoWindow>
    </div>
  )
}
