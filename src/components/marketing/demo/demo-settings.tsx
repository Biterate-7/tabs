"use client"

import { AppWindow, Bot, Boxes, ChevronLeft, Keyboard } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { FieldRow, GroupLabel, SectionHeading, SectionStack } from "@/components/settings/sections/section-ui"
import { ShortcutsSection, WorkspacesSection } from "@/components/settings/sections/system-sections"
import { ThemeCard } from "@/components/settings/sections/theme-card"
import { IconButton } from "@/components/ui/icon-button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { PLATFORM_FEATURE_LABEL, PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import { THEME_REGISTRY, getTheme } from "@/lib/appearance/themes"
import { cn } from "@/lib/utils"
import { DEMO_AGENTS } from "./data"
import { useHubbleDemo, type DemoScheme } from "./demo-provider"
import type { DemoSettingsSection } from "./demo-state"

const NAV: { id: DemoSettingsSection; label: string; icon: typeof Bot }[] = [
  { id: "appearance", label: "Appearance", icon: AppWindow },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "workspaces", label: "Workspaces", icon: Boxes },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
]

const SYSTEM_THEMES = ["hubble-light", "midnight"] as const

/**
 * Settings, in the app's settings grammar: a narrow section list, one pane at
 * a reading width, hairlined groups of rows.
 *
 * Workspaces and Shortcuts are the app's own sections, handed the demo's
 * workspaces. Appearance shows Hubble's two system themes with the app's own
 * theme cards, and choosing one sets this page's colour scheme — the demo
 * never touches the visitor's real appearance settings. Agents lists each
 * connector as the catalog describes it, including what it cannot do.
 *
 * The app's other sections (typography, providers, MCP, account, …) read or
 * write real settings, keys and tokens, so they are not part of the demo.
 */
export function DemoSettings({ onClose }: { onClose?: () => void }) {
  const { state, dispatch, scheme } = useHubbleDemo()
  const active = state.settingsSection

  const row = (item: (typeof NAV)[number]) => {
    const Icon = item.icon
    const current = active === item.id
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => dispatch({ type: "settings-section", section: item.id })}
        aria-current={current}
        className={cn(
          "flex h-[30px] w-full items-center gap-2 rounded-xs px-2 text-left text-body transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          current ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{item.label}</span>
      </button>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {onClose && (
          <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
            <ChevronLeft />
          </IconButton>
        )}
        <p className="text-h2 text-foreground">Settings</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Settings sections" className="hidden w-56 shrink-0 flex-col gap-px overflow-y-auto border-r border-border p-2 sm:flex">
          {NAV.map(row)}
        </nav>
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:hidden">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => dispatch({ type: "settings-section", section: item.id })}
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

        <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-[680px] px-5 py-8 sm:px-8 sm:py-10">
            {active === "appearance" && <AppearancePane scheme={scheme} />}
            {active === "agents" && <AgentsPane />}
            {active === "workspaces" && (
              <WorkspacesSection
                workspaces={state.store.workspaces}
                currentId={state.store.currentId}
                onSwitch={(id) => dispatch({ type: "switch-workspace", id })}
                onRename={(id, name) => dispatch({ type: "rename-workspace", id, name })}
                onDelete={(id) => dispatch({ type: "delete-workspace", id })}
                onUpdateLogo={(id, logo) => dispatch({ type: "update-logo", id, logo })}
              />
            )}
            {active === "shortcuts" && <ShortcutsSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

function AppearancePane({ scheme }: { scheme?: { value: DemoScheme; set: (scheme: DemoScheme) => void } }) {
  const value = scheme?.value ?? "system"
  return (
    <div>
      <SectionHeading title="Theme" description="Hubble ships two system palettes, warm paper and warm ink. In the demo, this sets the page's colour scheme." />
      <SectionStack className="mb-6">
        <FieldRow label="Appearance" description="Follow the system, or choose one.">
          <SegmentedControl<DemoScheme>
            size="sm"
            value={value}
            onValueChange={(next) => scheme?.set(next)}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </FieldRow>
      </SectionStack>
      <GroupLabel>System</GroupLabel>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SYSTEM_THEMES.map((id) => {
          const theme = getTheme(id)
          if (!theme) return null
          const themeScheme: DemoScheme = id === "midnight" ? "dark" : "light"
          return (
            <ThemeCard
              key={id}
              theme={theme}
              selected={value === themeScheme}
              favorited={false}
              onSelect={() => scheme?.set(themeScheme)}
              onToggleFavorite={() => undefined}
            />
          )
        })}
      </div>
      <p className="mt-4 text-body-sm text-tertiary">
        Hubble has {THEME_REGISTRY.length} themes, a custom palette editor, typography, layout and motion settings.
      </p>
    </div>
  )
}

function AgentsPane() {
  const connected = new Set(DEMO_AGENTS.map((agent) => agent.provider))
  return (
    <div>
      <SectionHeading
        title="Agents"
        description="Connect the agents you already use. Each runs on your own account or key, and asks before it changes anything."
      />
      <div className="flex flex-col gap-4">
        {PLATFORM_PROVIDERS.map((spec) => (
          <SectionStack key={spec.provider}>
            <div className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 text-muted-foreground">
                <AgentIcon connector={spec.provider} size="sm" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <p className="text-body text-foreground">{spec.displayName}</p>
                  <p className="text-meta text-tertiary">{spec.vendor}</p>
                </div>
                <p className="mt-0.5 text-body-sm text-muted-foreground">{spec.pitch}</p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-xs px-1.5 py-0.5 text-meta font-medium",
                  connected.has(spec.provider) ? "bg-surface-active text-foreground" : "text-tertiary"
                )}
              >
                {connected.has(spec.provider) ? "Connected" : "Not connected"}
              </span>
            </div>
            <FieldRow label="Sessions" description={spec.sessions.available ? "Hubble starts and runs sessions with it." : spec.sessions.reason}>
              <span className="text-body-sm text-muted-foreground">{spec.sessions.available ? "Available" : "Unavailable"}</span>
            </FieldRow>
            <div className="px-4 py-3">
              <p className="text-label text-muted-foreground">What it does in Hubble</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {spec.features.map((feature) => (
                  <li key={feature} className="text-body-sm text-foreground">
                    {PLATFORM_FEATURE_LABEL[feature]}
                  </li>
                ))}
              </ul>
            </div>
          </SectionStack>
        ))}
      </div>
    </div>
  )
}
