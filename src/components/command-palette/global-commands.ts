import {
  Bot,
  Boxes,
  Clock,
  FolderPlus,
  Globe,
  Keyboard,
  Moon,
  Palette,
  PlugZap,
  Radio,
  ScanSearch,
  ScrollText,
  Settings,
  Star,
  Sun,
  Type,
  Waypoints,
} from "lucide-react"
import type { Workspace } from "@/lib/workspace/types"
import type { SettingsSection } from "@/components/settings/appearance-settings-view"
import type { Command } from "./types"

/**
 * The commands the shell offers everywhere, whatever view is on screen.
 *
 * Navigation, agents, workspaces, every saved tab, and settings. The
 * workspace view adds its own (selection, sort, sections, export) while it
 * is mounted — see palette-host.tsx. Nothing here performs an action a
 * user could not already take from the sidebar or a view; the palette is a
 * faster route to the same places, never a new capability.
 */
export type GlobalCommandActions = {
  goWorkspace: () => void
  openGraph: () => void
  openFavorites: () => void
  openRecents: () => void
  openHistoryDump: () => void
  openCommandCentre: () => void
  openAgentHistory: () => void
  openSettings: (section?: SettingsSection) => void
  switchWorkspace: (id: string) => void
  newWorkspace: () => void
  openUrl: (url: string) => void
  /** Present only when appearance settings are available. */
  setTheme?: (themeId: "midnight" | "hubble-light") => void
}

/** How many saved tabs the palette indexes. Past this, search the workspace itself. */
const TAB_LIMIT = 400

export function buildGlobalCommands(
  actions: GlobalCommandActions,
  data: { workspaces: Workspace[]; currentId: string; themeId?: string }
): Command[] {
  const current = data.workspaces.find((w) => w.id === data.currentId)

  const navigation: Command[] = [
    { id: "go-workspace", label: "Go to Workspace", group: "Navigation", icon: Boxes, onSelect: actions.goWorkspace, keywords: ["tabs", "home"] },
    { id: "go-graph", label: "Open graph view", group: "Navigation", icon: Waypoints, onSelect: actions.openGraph, keywords: ["relationships", "map"] },
    { id: "go-favorites", label: "Go to Favorites", group: "Navigation", icon: Star, onSelect: actions.openFavorites },
    { id: "go-recents", label: "Go to Recents", group: "Navigation", icon: Clock, onSelect: actions.openRecents },
    { id: "go-history-dump", label: "Go to History Dump", group: "Navigation", icon: ScanSearch, onSelect: actions.openHistoryDump },
  ]

  const agents: Command[] = [
    { id: "agents-command-centre", label: "Open Command Centre", group: "Agents", icon: Radio, onSelect: actions.openCommandCentre, keywords: ["agent", "session"] },
    {
      id: "agents-start",
      label: "Start an agent session",
      hint: "Claude Code, Codex, Gemini CLI, Grok Build",
      group: "Agents",
      icon: Bot,
      onSelect: actions.openCommandCentre,
      keywords: ["new", "run", "switch agent"],
    },
    {
      id: "agents-connect",
      label: "Connect an agent",
      hint: "Providers, permissions and MCP",
      group: "Agents",
      icon: PlugZap,
      onSelect: () => actions.openSettings("connectors"),
      keywords: ["provider", "mcp", "claude", "codex", "gemini", "grok"],
    },
    { id: "agents-history", label: "Agent history", group: "Agents", icon: ScrollText, onSelect: actions.openAgentHistory },
  ]

  const workspaces: Command[] = [
    ...data.workspaces.map(
      (w): Command => ({
        id: `workspace-switch-${w.id}`,
        label: w.id === data.currentId ? `${w.name}` : `Switch to ${w.name}`,
        hint: `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}${w.id === data.currentId ? " · current" : ""}`,
        group: "Workspaces",
        icon: Boxes,
        onSelect: () => {
          actions.switchWorkspace(w.id)
          actions.goWorkspace()
        },
        keywords: ["open workspace", "workspace"],
      })
    ),
    { id: "workspace-new", label: "New workspace", group: "Workspaces", icon: FolderPlus, onSelect: actions.newWorkspace, keywords: ["create"] },
  ]

  // Every saved tab, current workspace first, so "search tabs" is just typing.
  const ordered = current ? [current, ...data.workspaces.filter((w) => w.id !== current.id)] : data.workspaces
  const tabs: Command[] = []
  for (const w of ordered) {
    for (const tab of w.tabs) {
      if (tabs.length >= TAB_LIMIT) break
      tabs.push({
        id: `tab-${w.id}-${tab.id}`,
        label: tab.title?.trim() || tab.url,
        hint: w.id === data.currentId ? tab.domain : `${tab.domain} · ${w.name}`,
        group: "Tabs",
        icon: Globe,
        onSelect: () => actions.openUrl(tab.url),
        keywords: [tab.url],
      })
    }
  }

  const settings: Command[] = [
    { id: "settings-open", label: "Open settings", group: "Settings", icon: Settings, onSelect: () => actions.openSettings("general"), keywords: ["preferences"] },
    { id: "settings-agents", label: "Agents and providers", group: "Settings", icon: PlugZap, onSelect: () => actions.openSettings("connectors") },
    { id: "settings-theme", label: "Change theme", group: "Settings", icon: Palette, onSelect: () => actions.openSettings("theme"), keywords: ["appearance", "color"] },
    { id: "settings-typography", label: "Change typography", group: "Settings", icon: Type, onSelect: () => actions.openSettings("typography"), keywords: ["font"] },
    ...(actions.setTheme
      ? [
          data.themeId === "hubble-light"
            ? { id: "settings-dark", label: "Use dark theme", group: "Settings" as const, icon: Moon, onSelect: () => actions.setTheme?.("midnight") }
            : { id: "settings-light", label: "Use light theme", group: "Settings" as const, icon: Sun, onSelect: () => actions.setTheme?.("hubble-light") },
        ]
      : []),
    { id: "settings-shortcuts", label: "Keyboard shortcuts", hint: "Ctrl/⌘ K anywhere · / to search the workspace", group: "Help", icon: Keyboard, onSelect: () => actions.openSettings("shortcuts") },
  ]

  return [...navigation, ...agents, ...workspaces, ...tabs, ...settings]
}

/**
 * Global first, then each contributed list, dropping any command whose label
 * an earlier one already claimed — the workspace view and the shell both
 * offer "Go to Favorites", and one row is enough.
 */
export function mergeCommands(global: Command[], contributed: Iterable<Command[]>): Command[] {
  const seen = new Set<string>()
  const out: Command[] = []
  for (const list of [global, ...contributed]) {
    for (const command of list) {
      const key = `${command.group}:${command.label}`.toLowerCase()
      const labelKey = command.label.toLowerCase()
      if (seen.has(key) || seen.has(labelKey)) continue
      seen.add(key)
      seen.add(labelKey)
      out.push(command)
    }
  }
  return out
}
