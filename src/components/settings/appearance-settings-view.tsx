"use client"

import { useState } from "react"
import {
  AppWindow,
  ChevronLeft,
  Database,
  MessagesSquare,
  Puzzle,
  Image,
  Keyboard,
  LayoutGrid,
  Monitor,
  Paintbrush,
  Palette,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Squircle,
  Type,
  UserRound,
  Boxes,
  Cable,
} from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { cn } from "@/lib/utils"
import { GeneralSection } from "./sections/general-section"
import { ThemeSection } from "./sections/theme-section"
import { TypographySection } from "./sections/typography-section"
import { BackgroundSection } from "./sections/background-section"
import { LayoutSection } from "./sections/layout-section"
import { ShapeSection } from "./sections/shape-section"
import { MotionSection } from "./sections/motion-section"
import { AccentSection } from "./sections/accent-section"
import { AiIntegrationsSection } from "./sections/ai-integrations-section"
import { AiAppsSection, DataSection } from "./sections/knowledge-sections"
import { DesktopSection } from "./sections/desktop-section"
import {
  AccountSettingsSection,
  AdvancedSection,
  ExtensionSection,
  PrivacySection,
  ShortcutsSection,
  WorkspacesSection,
  type WorkspaceSettingsProps,
} from "./sections/system-sections"

export type SettingsSection =
  | "general"
  | "theme"
  | "typography"
  | "background"
  | "layout"
  | "shape"
  | "motion"
  | "accent"
  | "account"
  /** What Hubble can do with each AI app (src/lib/providers/registry.ts). */
  | "ai-apps"
  /** "AI connectors" in the nav: ChatGPT, Claude, Gemini and Grok reading Hubble over MCP (src/lib/integrations). */
  | "ai-integrations"
  /** Export, and the records left by removed features. */
  | "data"
  | "workspaces"
  | "shortcuts"
  | "desktop"
  | "extension"
  | "privacy"
  | "advanced"

type NavItem = { id: SettingsSection; label: string; icon: typeof Settings2 }

const APPEARANCE: NavItem[] = [
  { id: "theme", label: "Theme", icon: Palette },
  { id: "typography", label: "Typography", icon: Type },
  { id: "background", label: "Background", icon: Image },
  { id: "layout", label: "Layout", icon: LayoutGrid },
  { id: "shape", label: "Shape", icon: Squircle },
  { id: "motion", label: "Motion", icon: Sparkles },
  { id: "accent", label: "Accent", icon: Paintbrush },
]
const APPEARANCE_IDS = new Set(APPEARANCE.map((item) => item.id))

const BEFORE: NavItem[] = [{ id: "general", label: "General", icon: Settings2 }]
const AFTER: NavItem[] = [
  { id: "account", label: "Account", icon: UserRound },
  { id: "ai-apps", label: "AI apps", icon: MessagesSquare },
  { id: "ai-integrations", label: "AI connectors", icon: Cable },
  { id: "workspaces", label: "Projects", icon: Boxes },
  { id: "data", label: "Data", icon: Database },
  { id: "extension", label: "Chrome extension", icon: Puzzle },
  { id: "desktop", label: "Desktop app", icon: Monitor },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "privacy", label: "Privacy", icon: Shield },
]
/** Technical settings, kept and labelled as such. MCP lives under AI connectors; the browser under Chrome extension. */
const ADVANCED: NavItem[] = [{ id: "advanced", label: "Diagnostics", icon: SlidersHorizontal }]

/**
 * Settings.
 *
 * The reference's settings grammar: a narrow list of sections on the left,
 * one pane on the right at a reading width, and in the pane hairlined groups
 * of rows rather than a board of cards. Appearance is one entry whose
 * seven parts unfold beneath it only while one of them is open, so the list
 * stays short.
 *
 * Mounted as a destination inside the shell (see app-shell.tsx), not a
 * modal: appearance alone is larger than a dialog can hold.
 */
export function AppearanceSettingsView({
  onClose,
  initialSection,
  workspaceSettings,
}: {
  onClose: () => void
  /**
   * Which section to open on. An initial value, not a controlled prop: once
   * here, the nav is the user's.
   */
  initialSection?: SettingsSection
  /** The workspace list and its actions, for Settings → Workspaces. Omitted where there is no store (tests). */
  workspaceSettings?: WorkspaceSettingsProps
}) {
  const [active, setActive] = useState<SettingsSection>(initialSection ?? "general")
  const inAppearance = APPEARANCE_IDS.has(active)

  const row = (item: NavItem, nested = false) => {
    const Icon = item.icon
    const current = active === item.id
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setActive(item.id)}
        aria-current={current}
        aria-label={item.label}
        className={cn(
          "flex h-[30px] w-full items-center gap-2 rounded-xs pr-2 text-left text-body transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          nested ? "pl-8" : "pl-2",
          current
            ? "bg-surface-selected text-foreground"
            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
        )}
      >
        {!nested && <Icon className="size-4 shrink-0" aria-hidden />}
        <span className="truncate">{item.label}</span>
      </button>
    )
  }

  return (
    <div
      className="relative flex h-screen max-h-screen min-w-0 flex-1 flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <p className="text-h2 text-foreground">Settings</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="Settings sections"
          className="hidden w-56 shrink-0 flex-col gap-px overflow-y-auto border-r border-border p-2 sm:flex"
        >
          {BEFORE.map((item) => row(item))}
          <button
            type="button"
            onClick={() => !inAppearance && setActive("theme")}
            aria-expanded={inAppearance}
            className={cn(
              "flex h-[30px] w-full items-center gap-2 rounded-xs px-2 text-left text-body transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              inAppearance ? "text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            )}
          >
            <AppWindow className="size-4 shrink-0" aria-hidden />
            Appearance
          </button>
          {inAppearance && APPEARANCE.map((item) => row(item, true))}
          {AFTER.map((item) => row(item))}
          <div className="mt-3 border-t border-subtle pt-3">{ADVANCED.map((item) => row(item))}</div>
        </nav>

        {/* Below `sm` the section list becomes one horizontal strip. */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:hidden">
          {[...BEFORE, ...APPEARANCE, ...AFTER, ...ADVANCED].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActive(item.id)}
              aria-current={active === item.id}
              className={cn(
                "h-6 shrink-0 rounded-full px-2.5 text-body-sm",
                active === item.id ? "bg-surface-active text-foreground" : "text-muted-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[680px] px-5 py-8 sm:px-8 sm:py-10">
            {active === "general" && <GeneralSection />}
            {active === "theme" && <ThemeSection />}
            {active === "typography" && <TypographySection />}
            {active === "background" && <BackgroundSection />}
            {active === "layout" && <LayoutSection />}
            {active === "shape" && <ShapeSection />}
            {active === "motion" && <MotionSection />}
            {active === "accent" && <AccentSection />}
            {active === "account" && <AccountSettingsSection />}
            {active === "ai-apps" && <AiAppsSection />}
            {active === "ai-integrations" && <AiIntegrationsSection />}
            {active === "data" && <DataSection workspaces={workspaceSettings?.workspaces ?? []} />}
            {active === "workspaces" &&
              (workspaceSettings ? (
                <WorkspacesSection {...workspaceSettings} />
              ) : (
                <p className="text-body text-muted-foreground">No projects to show here.</p>
              ))}
            {active === "shortcuts" && <ShortcutsSection />}
            {active === "desktop" && <DesktopSection />}
            {active === "extension" && <ExtensionSection />}
            {active === "privacy" && <PrivacySection />}
            {active === "advanced" && <AdvancedSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
