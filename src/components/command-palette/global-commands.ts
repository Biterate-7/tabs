import { Layers, Library, Orbit, Boxes, Clock, Database, FileUp, FolderPlus, Globe, Group, House, Keyboard, MessageSquareShare, MessagesSquare, Moon, NotebookPen, Palette, Cable, ScanSearch, Search, Settings, Star, Sun, Type, Waypoints } from "lucide-react"
import type { Workspace } from "@/lib/workspace/types"
import type { SettingsSection } from "@/components/settings/appearance-settings-view"
import type { CaptureMode } from "@/components/memory/capture-dialog"
import type { Command } from "./types"

/**
 * The commands the shell offers everywhere, whatever view is on screen.
 *
 * Navigation, using what is saved in an AI chat, bringing things in,
 * projects, every saved tab, and settings. The workspace view adds its own
 * (selection, sort, sections, export) while it is mounted — see
 * palette-host.tsx. Nothing here performs an action a person could not
 * already take from the sidebar or a view; the palette is a faster route to
 * the same places, never a new capability.
 */
export type GlobalCommandActions = {
  goWorkspace: () => void
  openGraph: () => void
  openFavorites: () => void
  openRecents: () => void
  openHistoryDump: () => void
  openSettings: (section?: SettingsSection) => void
  switchWorkspace: (id: string) => void
  newWorkspace: () => void
  openUrl: (url: string) => void
  /** Present only when appearance settings are available. */
  setTheme?: (themeId: "midnight" | "hubble-light") => void
  /** Projects (Home). Present inside the shell. */
  goHome?: () => void
  /** The knowledge search page, optionally with a query. Present inside the shell. */
  openSearch?: (query?: string) => void
  /** The context builder for the current project. Present inside the shell. */
  reuseCurrent?: () => void
  /** The capture dialog on the current project. Present inside the shell. */
  capture?: (mode: CaptureMode) => void
  /** How to save AI conversations with Hubble for Chrome. Present inside the shell. */
  saveFromAi?: () => void
  /** Smart Organize for the tabs open in Chrome. Present inside the shell. */
  organizeOpenTabs?: () => void
  /** The AI page. Present inside the shell. */
  goAi?: () => void
  /** The Library. Present inside the shell. */
  goLibrary?: () => void
  /** Saved browser sessions. Present where sessions exist (not Hubble Desktop). */
  goSessions?: () => void
  /** The map of saved tabs. Present when there are saved tabs. */
  openTabMap?: () => void
}

/** How many saved tabs the palette indexes. Past this, search the workspace itself. */
const TAB_LIMIT = 400

export function buildGlobalCommands(
  actions: GlobalCommandActions,
  data: { workspaces: Workspace[]; currentId: string; themeId?: string }
): Command[] {
  const current = data.workspaces.find((w) => w.id === data.currentId)

  const navigation: Command[] = [
    ...(actions.goHome ? [{ id: "go-home", label: "Go to Home", group: "Navigation" as const, icon: House, onSelect: actions.goHome, keywords: ["home", "start", "projects", "continue"] }] : []),
    ...(actions.openSearch ? [{ id: "go-search", label: "Search", group: "Navigation" as const, icon: Search, onSelect: () => actions.openSearch?.(), keywords: ["find", "memory", "conversations", "notes"] }] : []),
    { id: "go-workspace", label: current ? `Go to ${current.name}` : "Go to project", group: "Navigation", icon: Boxes, onSelect: actions.goWorkspace, keywords: ["workspace", "project", "tabs"] },
    { id: "go-graph", label: "Go to Graph", group: "Navigation", icon: Orbit, onSelect: actions.openGraph, keywords: ["relationships", "map", "knowledge graph", "connections"] },
    ...(actions.goAi ? [{ id: "go-ai", label: "Go to AI", group: "Navigation" as const, icon: MessageSquareShare, onSelect: actions.goAi, keywords: ["chatgpt", "claude", "gemini", "perplexity", "use in ai", "context"] }] : []),
    ...(actions.goLibrary ? [{ id: "go-library", label: "Go to Library", group: "Navigation" as const, icon: Library, onSelect: actions.goLibrary, keywords: ["conversations", "files", "documents", "notes", "sources"] }] : []),
    ...(actions.goSessions ? [{ id: "go-sessions", label: "Go to Sessions", group: "Navigation" as const, icon: Layers, onSelect: actions.goSessions, keywords: ["tabs", "restore", "resume", "browser"] }] : []),
    ...(actions.openTabMap ? [{ id: "go-tab-map", label: "Go to Tab map", group: "Navigation" as const, icon: Waypoints, onSelect: actions.openTabMap, keywords: ["saved tabs", "sections", "domains"] }] : []),
    { id: "go-favorites", label: "Go to Favorites", group: "Navigation", icon: Star, onSelect: actions.openFavorites },
    { id: "go-recents", label: "Go to Recent", group: "Navigation", icon: Clock, onSelect: actions.openRecents },
    { id: "go-history-dump", label: "Import from history", group: "Navigation", icon: ScanSearch, onSelect: actions.openHistoryDump, keywords: ["history dump"] },
  ]

  const memory: Command[] = [
    ...(actions.reuseCurrent && current
      ? [
          {
            id: "memory-use-project",
            label: `Use ${current.name} in AI`,
            group: "Memory" as const,
            icon: MessageSquareShare,
            onSelect: actions.reuseCurrent,
            keywords: ["context", "memory", "reuse", "chatgpt", "claude", "gemini", "perplexity", "copy"],
          },
        ]
      : []),
    ...(actions.saveFromAi
      ? [{ id: "save-from-ai", label: "Save AI conversations with Hubble for Chrome", group: "Memory" as const, icon: MessagesSquare, onSelect: actions.saveFromAi, keywords: ["save", "import", "chatgpt", "claude", "gemini", "perplexity", "chat", "extension"] }]
      : []),
    ...(actions.capture && current
      ? [
          { id: "capture-note", label: `Write a note in ${current.name}`, group: "Memory" as const, icon: NotebookPen, onSelect: () => actions.capture?.("note"), keywords: ["excerpt", "decision", "idea"] },
          { id: "capture-import", label: `Import AI chats into ${current.name}`, group: "Memory" as const, icon: FileUp, onSelect: () => actions.capture?.("import"), keywords: ["conversations.json", "export", "file"] },
        ]
      : []),
  ]

  const workspaces: Command[] = [
    ...data.workspaces.map(
      (w): Command => ({
        id: `workspace-switch-${w.id}`,
        label: w.id === data.currentId ? `${w.name}` : `Open ${w.name}`,
        hint: `${w.tabs.length + (w.notes?.length ?? 0)} item${w.tabs.length + (w.notes?.length ?? 0) === 1 ? "" : "s"}`,
        group: "Workspaces",
        icon: Boxes,
        onSelect: () => {
          actions.switchWorkspace(w.id)
          actions.goWorkspace()
        },
        keywords: ["open project", "workspace", "project", "switch"],
      })
    ),
    { id: "workspace-new", label: "New project", group: "Workspaces", icon: FolderPlus, onSelect: actions.newWorkspace, keywords: ["create", "workspace", "subject"] },
    ...(actions.organizeOpenTabs
      ? [
          {
            id: "organize-open-tabs",
            label: "Organize open tabs",
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
        icon: tab.resource?.kind === "conversation" ? MessagesSquare : Globe,
        site: { domain: tab.domain, favicon: tab.favicon },
        onSelect: () => actions.openUrl(tab.url),
        keywords: [tab.url],
      })
    }
  }

  const settings: Command[] = [
    { id: "settings-open", label: "Open settings", group: "Settings", icon: Settings, onSelect: () => actions.openSettings("general"), keywords: ["preferences"] },
    { id: "settings-ai-apps", label: "AI apps", group: "Settings", icon: MessagesSquare, onSelect: () => actions.openSettings("ai-apps"), keywords: ["providers", "capture", "extension"] },
    { id: "settings-connectors", label: "AI connectors", group: "Settings", icon: Cable, onSelect: () => actions.openSettings("ai-integrations"), keywords: ["mcp", "connect", "integration"] },
    { id: "settings-data", label: "Export your data", group: "Settings", icon: Database, onSelect: () => actions.openSettings("data"), keywords: ["backup", "download", "delete"] },
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

  return [...navigation, ...memory, ...workspaces, ...tabs, ...settings]
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
