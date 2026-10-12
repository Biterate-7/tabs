import { Bot, Boxes, Clock, FolderPlus, Globe, Group, Keyboard, Moon, Palette, PlugZap, Radio, ScanSearch, ScrollText, Settings, Star, Sun, Type, Waypoints, House } from "lucide-react"
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
  /** Opens the Command Centre working in the current workspace. Present inside the shell. */
  askAgentAboutWorkspace?: () => void
  /** Home, and the AI page. Present inside the shell. */
  goHome?: () => void
  openAI?: () => void
  /** Smart Organize for the tabs open in Chrome. Present inside the shell. */
  organizeOpenTabs?: () => void
}

/** How many saved tabs the palette indexes. Past this, search the workspace itself. */
const TAB_LIMIT = 400

export function buildGlobalCommands(
  actions: GlobalCommandActions,
  data: { workspaces: Workspace[]; currentId: string; themeId?: string }
): Command[] {
  const current = data.workspaces.find((w) => w.id === data.currentId)

  const navigation: Command[] = [
    ...(actions.goHome ? [{ id: "go-home", label: "Go to Home", group: "Navigation" as const, icon: House, onSelect: actions.goHome, keywords: ["subjects", "start"] }] : []),
    ...(actions.openAI ? [{ id: "go-ai", label: "Open AI", group: "Navigation" as const, icon: Bot, onSelect: actions.openAI, keywords: ["ask", "agent", "connections"] }] : []),
    { id: "go-workspace", label: current ? `Go to ${current.name}` : "Go to subject", group: "Navigation", icon: Boxes, onSelect: actions.goWorkspace, keywords: ["workspace", "subject", "tabs"] },
    { id: "go-graph", label: "Open graph view", group: "Navigation", icon: Waypoints, onSelect: actions.openGraph, keywords: ["relationships", "map"] },
    { id: "go-favorites", label: "Go to Favorites", group: "Navigation", icon: Star, onSelect: actions.openFavorites },
    { id: "go-recents", label: "Go to Recents", group: "Navigation", icon: Clock, onSelect: actions.openRecents },
    { id: "go-history-dump", label: "Import from history", group: "Navigation", icon: ScanSearch, onSelect: actions.openHistoryDump, keywords: ["history dump"] },
  ]

  const agents: Command[] = [
    ...(actions.askAgentAboutWorkspace && current
      ? [
          {
            id: "agents-ask-workspace",
            label: `Ask AI about ${current.name}`,
            hint: "Starts a chat about this subject",
            group: "Agents" as const,
            icon: Bot,
            onSelect: actions.askAgentAboutWorkspace,
            keywords: ["agent", "context", "workspace", "claude", "codex", "gemini"],
          },
        ]
      : []),
    { id: "agents-command-centre", label: "Open AI chats", group: "Agents", icon: Radio, onSelect: actions.openCommandCentre, keywords: ["command centre", "agent", "session", "ai"] },
    {
      id: "agents-start",
      label: "Start an AI chat",
      hint: "Claude, Codex, Gemini, Grok",
      group: "Agents",
      icon: Bot,
      onSelect: actions.openCommandCentre,
      keywords: ["new", "run", "switch agent", "agent session"],
    },
    {
      id: "agents-connect",
      label: "Connect AI",
      hint: "AI Connections",
      group: "Agents",
      icon: PlugZap,
      onSelect: () => actions.openSettings("connectors"),
      keywords: ["provider", "mcp", "claude", "codex", "gemini", "grok", "connect an agent"],
    },
    { id: "agents-history", label: "AI activity", group: "Agents", icon: ScrollText, onSelect: actions.openAgentHistory, keywords: ["agent history"] },
  ]

  const workspaces: Command[] = [
    ...data.workspaces.map(
      (w): Command => ({
        id: `workspace-switch-${w.id}`,
        label: w.id === data.currentId ? `${w.name}` : `Open ${w.name}`,
        hint: `${w.tabs.length} resource${w.tabs.length === 1 ? "" : "s"}`,
        group: "Workspaces",
        icon: Boxes,
        onSelect: () => {
          actions.switchWorkspace(w.id)
          actions.goWorkspace()
        },
        keywords: ["open workspace", "workspace", "subject", "switch"],
      })
    ),
    { id: "workspace-new", label: "New subject", group: "Workspaces", icon: FolderPlus, onSelect: actions.newWorkspace, keywords: ["create", "workspace"] },
    ...(actions.organizeOpenTabs
      ? [
          {
            id: "organize-open-tabs",
            label: "Organize open tabs",
            hint: "Group the tabs open in Chrome into subjects",
            group: "Workspaces" as const,
            icon: Group,
            onSelect: actions.organizeOpenTabs,
            keywords: ["smart organize", "sort", "group", "tidy", "chrome", "duplicates"],
          },
        ]
      : []),
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
        site: { domain: tab.domain, favicon: tab.favicon },
        onSelect: () => actions.openUrl(tab.url),
        keywords: [tab.url],
      })
    }
  }

  const settings: Command[] = [
    { id: "settings-open", label: "Open settings", group: "Settings", icon: Settings, onSelect: () => actions.openSettings("general"), keywords: ["preferences"] },
    { id: "settings-agents", label: "AI Connections", group: "Settings", icon: PlugZap, onSelect: () => actions.openSettings("connectors"), keywords: ["agents", "providers"] },
    { id: "settings-theme", label: "Change theme", group: "Settings", icon: Palette, onSelect: () => actions.openSettings("theme"), keywords: ["appearance", "color"] },
    { id: "settings-typography", label: "Change typography", group: "Settings", icon: Type, onSelect: () => actions.openSettings("typography"), keywords: ["font"] },
    ...(actions.setTheme
      ? [
          data.themeId === "hubble-light"
            ? { id: "settings-dark", label: "Use dark theme", group: "Settings" as const, icon: Moon, onSelect: () => actions.setTheme?.("midnight") }
            : { id: "settings-light", label: "Use light theme", group: "Settings" as const, icon: Sun, onSelect: () => actions.setTheme?.("hubble-light") },
        ]
      : []),
    { id: "settings-shortcuts", label: "Keyboard shortcuts", hint: "Ctrl/⌘ K anywhere", group: "Help", icon: Keyboard, onSelect: () => actions.openSettings("shortcuts") },
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
