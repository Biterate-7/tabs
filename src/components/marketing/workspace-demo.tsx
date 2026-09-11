"use client"

import { useState, type CSSProperties } from "react"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { DEMO_SECTIONS, DEMO_UNIQUE_TABS, DEMO_WORKSPACES, hashUnit } from "./data"
import { DemoFavicon, DemoWindow } from "./primitives"

/**
 * Workspace switching.
 *
 * The switch is keyed on the workspace id, so React remounts the content pane
 * and its staggered entrance replays every time — a cross-fade between two
 * static panes would say "these are two pictures", and the thing worth saying
 * is "this is a different room". Each workspace's contents are filtered out of
 * the shared corpus by section, so the tab counts on the rail are real.
 */

const WORKSPACE_TABS = new Map(
  DEMO_WORKSPACES.map((ws) => [ws.id, DEMO_UNIQUE_TABS.filter((t) => ws.sections.includes(t.section))] as const)
)

export function WorkspaceDemo() {
  const [activeId, setActiveId] = useState(DEMO_WORKSPACES[0].id)
  const active = DEMO_WORKSPACES.find((w) => w.id === activeId)!
  const tabs = WORKSPACE_TABS.get(activeId)!
  const sections = DEMO_SECTIONS.filter((s) => active.sections.includes(s.name))

  return (
    <DemoWindow
      title={active.name}
      label="Interactive demonstration: switching between TabDump workspaces"
      toolbar={<span className="m-num text-[0.6875rem] text-tertiary">{tabs.length} tabs</span>}
    >
      <div className="flex h-[24rem] min-h-0">
        {/* Rail */}
        <div
          role="tablist"
          aria-label="Workspaces"
          aria-orientation="vertical"
          className="flex w-[8.5rem] shrink-0 flex-col gap-1 border-r border-subtle p-2 sm:w-[11rem]"
        >
          <p className="m-label px-1.5 pt-1 pb-2">Spaces</p>
          {DEMO_WORKSPACES.map((ws) => {
            const isActive = ws.id === activeId
            const count = WORKSPACE_TABS.get(ws.id)!.length
            return (
              <button
                key={ws.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveId(ws.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2 py-2 text-left transition-[background-color,color] duration-(--duration-base) ease-(--ease-standard)",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isActive ? "bg-surface-active text-foreground" : "text-muted-foreground hover:bg-surface-hover"
                )}
              >
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full transition-opacity duration-(--duration-base)"
                  style={{
                    backgroundColor: `var(${CATEGORIES[ws.accent].accentColor})`,
                    opacity: isActive ? 1 : 0.45,
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-body-sm">{ws.name}</span>
                <span className="m-num shrink-0 text-[0.6875rem] text-tertiary">{count}</span>
              </button>
            )
          })}
          <p className="mt-auto hidden px-1.5 pt-4 pb-1 text-meta leading-relaxed text-tertiary sm:block">
            Separate rooms.
            <br />
            Nothing bleeds.
          </p>
        </div>

        {/* Content. Keyed so the entrance replays on every switch. */}
        <div key={activeId} className="min-w-0 flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-2.5">
            {sections.map((section, si) => {
              const sectionTabs = tabs.filter((t) => t.section === section.name).slice(0, 5)
              return (
                <div
                  key={section.name}
                  className="m-panel p-2.5"
                  style={
                    {
                      "--m-from-y": "14px",
                      "--m-from-x": "10px",
                      animation: `m-settle-in 400ms var(--m-spring) ${si * 80}ms both`,
                    } as CSSProperties
                  }
                >
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
                      {tabs.filter((t) => t.section === section.name).length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {sectionTabs.map((tab, ti) => (
                      <div
                        key={tab.id}
                        className="flex items-center gap-2 rounded-md border border-subtle bg-card/60 px-2 py-1.5"
                        style={
                          {
                            "--m-from-y": "10px",
                            "--m-from-x": `${(hashUnit(tab.id, 21) - 0.5) * 12}px`,
                            animation: `m-settle-in 380ms var(--m-spring) ${si * 80 + 110 + ti * 55}ms both`,
                          } as CSSProperties
                        }
                      >
                        <DemoFavicon domain={tab.domain} size={14} />
                        <span className="min-w-0 flex-1 truncate text-[0.75rem] leading-4 text-muted-foreground">
                          {tab.title}
                        </span>
                        <span className="hidden shrink-0 text-meta text-tertiary sm:block">{tab.subsection}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="border-t border-subtle px-3.5 py-3">
        <p className="text-body-sm text-tertiary">
          Pick a space on the left. Thesis reading never shows up while you are shipping code.
        </p>
      </div>
    </DemoWindow>
  )
}
