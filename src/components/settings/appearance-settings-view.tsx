"use client"

import { useState } from "react"
import { ChevronLeft, RotateCcw, Settings2, Palette, Type, Image, LayoutGrid, Squircle, Sparkles, Paintbrush, Bot, Boxes } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useAppearanceContext } from "@/components/appearance-provider"
import { cn } from "@/lib/utils"
import { GeneralSection } from "./sections/general-section"
import { ThemeSection } from "./sections/theme-section"
import { TypographySection } from "./sections/typography-section"
import { BackgroundSection } from "./sections/background-section"
import { LayoutSection } from "./sections/layout-section"
import { ShapeSection } from "./sections/shape-section"
import { MotionSection } from "./sections/motion-section"
import { AccentSection } from "./sections/accent-section"
import { ConnectorsSection } from "./sections/connectors-section"
import { AgentWorldSection } from "./sections/agent-world-section"

export type SettingsSection =
  | "general"
  | "connectors"
  | "agent-world"
  | "theme"
  | "typography"
  | "background"
  | "layout"
  | "shape"
  | "motion"
  | "accent"

/**
 * The sections the appearance reset applies to.
 *
 * Everything except connectors, which are not appearance — and whose "reset"
 * would mean disconnecting the user's agents, a destructive action with no
 * business hiding behind a button labelled about themes.
 */
const APPEARANCE_SECTIONS: readonly SettingsSection[] = [
  "general",
  "theme",
  "typography",
  "background",
  "layout",
  "shape",
  "motion",
  "accent",
]

const NAV: { id: SettingsSection; label: string; icon: typeof Settings2 }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "connectors", label: "AI connectors", icon: Bot },
  { id: "agent-world", label: "Agent World", icon: Boxes },
  { id: "theme", label: "Theme", icon: Palette },
  { id: "typography", label: "Typography", icon: Type },
  { id: "background", label: "Background", icon: Image },
  { id: "layout", label: "Layout", icon: LayoutGrid },
  { id: "shape", label: "Shape", icon: Squircle },
  { id: "motion", label: "Motion", icon: Sparkles },
  { id: "accent", label: "Accent", icon: Paintbrush },
]

/**
 * TabDump's Settings surface, mounted the same way Graph and the Notes page
 * are — a fixed full-page overlay toggled from AppShell, not a modal dialog
 * (see app-shell.tsx). Appearance settings are large enough (theme library,
 * custom editor, typography, background, layout, shape, motion, accent)
 * that the small Dialog this replaced couldn't reasonably hold them.
 */
export function AppearanceSettingsView({
  onClose,
  workspaceId,
  workspaceName,
  initialSection,
}: {
  onClose: () => void
  /**
   * Which section to open on.
   *
   * Exists so another surface can send someone straight to the settings they
   * came for — the Agent World's header does exactly that for "AI connectors"
   * and "Agent World settings", and a deep link that landed on Theme and left
   * them to find the right row would not be the one-click promise those
   * controls make. It is an initial value, not a controlled prop: once here,
   * the nav is the user's.
   */
  initialSection?: SettingsSection
  /**
   * The workspace Settings was opened over, when there is one.
   *
   * Only the Agent World section uses it, for the per-workspace environment
   * and world name. Passing it down rather than reading a store here keeps
   * this view free of workspace state, which is the reason it has stayed a
   * simple layout component through eight sections.
   */
  workspaceId?: string
  workspaceName?: string
}) {
  const { resetAllAppearance } = useAppearanceContext()
  const [active, setActive] = useState<SettingsSection>(initialSection ?? "theme")

  return (
    <div className="relative flex h-screen min-w-0 flex-1 flex-col bg-background" style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}>
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-6">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <p className="text-h2 text-foreground">Settings</p>
        <div className="ml-auto">
          {/* Appearance-only, and hidden where it would not apply: a reset
              button sitting above the AI connector list reads as though it
              might disconnect them. */}
          {APPEARANCE_SECTIONS.includes(active) && (
          <AlertDialog>
            <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
              <RotateCcw /> Reset appearance
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all appearance settings?</AlertDialogTitle>
                <AlertDialogDescription>
                  This puts theme, typography, background, layout, shape, motion, and accent back to their defaults. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => resetAllAppearance()}>
                  Reset
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-subtle p-2 sm:flex">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActive(item.id)}
                aria-current={active === item.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body-sm transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  active === item.id
                    ? "bg-surface-selected text-foreground"
                    : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                )}
              >
                <Icon className="size-4 shrink-0" />
                {item.label}
              </button>
            )
          })}
        </nav>

        <div className="flex gap-1.5 overflow-x-auto border-b border-subtle p-2 sm:hidden">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActive(item.id)}
              aria-current={active === item.id}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-label",
                active === item.id ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="mx-auto w-full max-w-3xl">
            {active === "general" && <GeneralSection />}
            {active === "connectors" && <ConnectorsSection />}
            {active === "agent-world" && (
              <AgentWorldSection workspaceId={workspaceId} workspaceName={workspaceName} />
            )}
            {active === "theme" && <ThemeSection />}
            {active === "typography" && <TypographySection />}
            {active === "background" && <BackgroundSection />}
            {active === "layout" && <LayoutSection />}
            {active === "shape" && <ShapeSection />}
            {active === "motion" && <MotionSection />}
            {active === "accent" && <AccentSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
