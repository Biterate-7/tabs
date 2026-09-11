"use client"

import { useState, type CSSProperties } from "react"
import { Check, History, RotateCcw } from "lucide-react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { cn } from "@/lib/utils"
import { DEMO_SESSIONS, DEMO_UNIQUE_TABS, hashUnit } from "./data"
import { useReducedMotion, useSequence } from "./hooks"
import { DemoWindow, MButton } from "./primitives"

/**
 * History Dump: a browsing session you never saved, recovered.
 *
 * Mirrors the real feature's shape rather than a generic "restore" button —
 * scanning history produces scored *candidates* you review and select from
 * (see src/lib/history-dump/types.ts), which is why this demo shows a
 * checklist with a suggested subset pre-ticked and a live count on the action,
 * instead of an all-or-nothing restore.
 */

type Phase = "browsing" | "restoring" | "done"

/** Candidate rows for a session, drawn from the shared corpus by its domains. */
function candidatesFor(sessionId: string) {
  const session = DEMO_SESSIONS.find((s) => s.id === sessionId)!
  const fromCorpus = DEMO_UNIQUE_TABS.filter((t) => session.domains.includes(t.domain))
  // A session's fingerprint domains do not always cover 6 rows; top up from
  // the same section so the list never looks thin.
  const filler = DEMO_UNIQUE_TABS.filter(
    (t) => !fromCorpus.includes(t) && t.section === (fromCorpus[0]?.section ?? "Research")
  )
  return [...fromCorpus, ...filler].slice(0, 6)
}

export function HistoryDemo() {
  const [sessionId, setSessionId] = useState(DEMO_SESSIONS[0].id)
  const [phase, setPhase] = useState<Phase>("browsing")
  // Deselecting is the interesting interaction here — the feature's point is
  // that you choose what comes back — so everything starts ticked.
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
  const reduced = useReducedMotion()
  const { run, clear } = useSequence()

  const session = DEMO_SESSIONS.find((s) => s.id === sessionId)!
  const candidates = candidatesFor(sessionId)
  const selected = candidates.filter((c) => !skipped.has(c.id))

  function pickSession(id: string) {
    clear()
    setSessionId(id)
    setSkipped(new Set())
    setPhase("browsing")
  }

  function restore() {
    if (phase !== "browsing" || selected.length === 0) return
    if (reduced) {
      setPhase("done")
      return
    }
    setPhase("restoring")
    run([{ at: 1000, do: () => setPhase("done") }])
  }

  return (
    <DemoWindow
      title="History Dump"
      label="Interactive demonstration: restoring a past browsing session"
      toolbar={<History aria-hidden className="size-3.5 text-tertiary" />}
    >
      <div className="flex min-h-0 flex-col sm:h-[23rem] sm:flex-row">
        {/* Sessions */}
        <div
          role="tablist"
          aria-label="Past sessions"
          className="flex shrink-0 flex-col gap-1 border-b border-subtle p-2 sm:w-[14rem] sm:border-r sm:border-b-0"
        >
          <p className="m-eyebrow px-1.5 pt-1 pb-2">Sessions</p>
          {DEMO_SESSIONS.map((s) => {
            const isActive = s.id === sessionId
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => pickSession(s.id)}
                className={cn(
                  "rounded-lg px-2 py-2 text-left transition-[background-color] duration-(--duration-base) ease-(--ease-standard)",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isActive ? "bg-surface-active" : "hover:bg-surface-hover"
                )}
              >
                <span className="flex items-baseline gap-2">
                  <span
                    className={cn("min-w-0 flex-1 truncate text-body-sm", isActive ? "text-foreground" : "text-muted-foreground")}
                  >
                    {s.label}
                  </span>
                  <span className="m-num shrink-0 text-[0.6875rem] text-tertiary">{s.tabCount}</span>
                </span>
                <span className="mt-1 flex items-center gap-1.5">
                  {s.domains.slice(0, 4).map((d) => (
                    <TabFavicon key={d} domain={d} size={12} />
                  ))}
                  <span className="truncate text-meta text-tertiary">{s.when}</span>
                </span>
              </button>
            )
          })}
        </div>

        {/* Candidates */}
        <div className="relative min-w-0 flex-1">
          <div
            className="flex h-full flex-col"
            style={{
              opacity: phase === "done" ? 0 : 1,
              transition: "opacity 320ms var(--m-ease)",
              pointerEvents: phase === "browsing" ? "auto" : "none",
            }}
            aria-hidden={phase === "done"}
          >
            <div className="flex items-center gap-2 border-b border-subtle px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{session.label}</span>
              <span className="m-num shrink-0 text-[0.6875rem] text-tertiary">
                {selected.length}/{candidates.length} selected
              </span>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2.5">
              {candidates.map((tab, i) => {
                const isSkipped = skipped.has(tab.id)
                return (
                  <label
                    key={tab.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-[opacity,border-color] duration-(--duration-base) ease-(--ease-standard)",
                      "has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                      isSkipped ? "border-subtle opacity-45" : "border-subtle bg-card/60"
                    )}
                    style={
                      phase === "restoring"
                        ? ({
                            "--m-from-x": "0px",
                            "--m-from-y": "0px",
                            opacity: isSkipped ? 0.2 : 0,
                            transform: `translateX(${isSkipped ? 0 : 26}px)`,
                            transition: `opacity 420ms var(--m-ease) ${i * 55}ms, transform 520ms var(--m-spring) ${i * 55}ms`,
                          } as CSSProperties)
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={!isSkipped}
                      onChange={() =>
                        setSkipped((prev) => {
                          const next = new Set(prev)
                          if (next.has(tab.id)) next.delete(tab.id)
                          else next.add(tab.id)
                          return next
                        })
                      }
                      className="size-3.5 shrink-0 accent-[var(--primary)]"
                    />
                    <TabFavicon domain={tab.domain} size={16} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm text-muted-foreground">{tab.title}</span>
                      <span className="block truncate text-meta text-tertiary">
                        {tab.domain} · visited {2 + Math.round(hashUnit(tab.id, 31) * 9)}×
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Payoff */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
            style={{
              opacity: phase === "done" ? 1 : 0,
              pointerEvents: phase === "done" ? "auto" : "none",
              transition: "opacity 380ms var(--m-ease) 120ms",
            }}
            aria-hidden={phase !== "done"}
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--success),transparent_75%)]">
              <Check className="size-4 text-success" strokeWidth={2.5} />
            </span>
            <p className="text-body text-foreground">
              <span className="m-num">{selected.length}</span> tabs back in{" "}
              <span className="text-foreground">{session.label}</span>
            </p>
            <p className="max-w-xs text-body-sm text-tertiary">
              Already sorted into sections, duplicates dropped — the same as any other dump.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-subtle px-3.5 py-3">
        {phase === "done" ? (
          <MButton variant="secondary" onClick={() => pickSession(sessionId)}>
            <RotateCcw />
            Try another session
          </MButton>
        ) : (
          <MButton onClick={restore} disabled={phase !== "browsing" || selected.length === 0}>
            {phase === "restoring" ? "Restoring…" : `Restore ${selected.length} tabs`}
          </MButton>
        )}
        <p className="text-body-sm text-tertiary">
          {phase === "done"
            ? "Nothing was open. Nothing was bookmarked. It came back anyway."
            : "Untick anything you don't want back."}
        </p>
      </div>
    </DemoWindow>
  )
}
