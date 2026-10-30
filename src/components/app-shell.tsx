"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { FirstRunLanding } from "@/components/marketing/first-run-landing"
import { getOnboardingState } from "@/lib/onboarding"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { HomeView } from "@/components/home/home-view"
import { SessionsView } from "@/components/sessions/sessions-view"
import { SearchView } from "@/components/search/search-view"
import { isPristineDefault, loadSubjectsStarted, markSubjectsStarted, subjectName, visibleSubjects } from "@/lib/product/subjects"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { AppearanceSettingsView } from "@/components/settings/appearance-settings-view"
import { KnowledgeGraphView } from "@/components/knowledge-graph/knowledge-graph-view"
import type { KnowledgeGraphTabActions } from "@/components/knowledge-graph/knowledge-graph-view"
import { LibraryView } from "@/components/library/library-view"
import { AiView } from "@/components/ai/ai-view"
import { useBrowserConnected } from "@/hooks/use-tab-sessions"
import type { AiProviderId } from "@/lib/providers/registry"
import { FavoritesView } from "@/components/workspace/favorites-view"
import { RecentsView } from "@/components/workspace/recents-view"
import { HistoryDumpView } from "@/components/workspace/history-dump-view"
import { isStorageAvailable, loadWorkspaceStore, saveWorkspaceStore, workspaceStoreStorageKey } from "@/lib/workspace/persistence"
import { migrateToWorkspaceStore } from "@/lib/workspace/migration"
import {
  addWorkspaces,
  assignTabsToSection,
  createSectionInWorkspace,
  createWorkspace,
  deleteSectionInWorkspace,
  deleteWorkspace,
  getCurrentWorkspace,
  moveTabsBetweenWorkspaces,
  renameSectionInWorkspace,
  renameWorkspace,
  switchWorkspace,
  updateWorkspaceLogo,
  updateWorkspaceTabs,
} from "@/lib/workspace/store"
import { setWorkspaceBrief } from "@/lib/workspace/brief"
import { describeIngestion, ingestResources } from "@/lib/resources/ingest"
import type { IngestionPlan, IngestOutcome } from "@/lib/resources/ingest"
import type { ResourceInput, ResourceOrigin } from "@/lib/resources/types"
import { deleteContent, pruneProjectContent, putContent } from "@/lib/resources/content-store"
import { sameResource } from "@/lib/resources/url"
import { searchTerms } from "@/lib/resources/search"
import { formatTimestamp } from "@/lib/resources/transcript"
import { parseYouTubeUrl, youtubeMomentUrl } from "@/lib/resources/youtube"
import { useTranscriptSearch } from "@/hooks/use-transcript-search"
import { PlayCircle, Search } from "lucide-react"
import { forgetProjectActivity, recordProjectEvent } from "@/lib/projects/activity"
import { useResourceProcessing } from "@/hooks/use-resource-processing"
import { useFileUploads } from "@/hooks/use-file-uploads"
import { ProjectHome, ProjectPage } from "@/components/project/project-home"
import type { NoteActions } from "@/components/project/project-home"
import { ReuseDialog } from "@/components/memory/reuse-dialog"
import { CaptureDialog } from "@/components/memory/capture-dialog"
import type { CaptureMode, ConversationSaveSummary, NoteSaveResult } from "@/components/memory/capture-dialog"
import { SaveFromAiDialog } from "@/components/memory/save-from-ai"
import { CONVERSATION_LINK_WORDS } from "@/components/project/add-source-dialog"
import { MemoryActionsProvider } from "@/components/memory/memory-actions"
import type { MemoryActions, MemorySelection } from "@/components/memory/memory-actions"
import { applyConversationSave, planConversationSave } from "@/lib/conversations/save"
import { cleanBody } from "@/lib/conversations/clean"
import { contentHash } from "@/lib/conversations/hash"
import { composeNote } from "@/lib/notes/compose"
import { addProjectNote, removeProjectNotes, updateProjectNote, NOTE_LIMITS } from "@/lib/notes/notes"
import { useExtensionMemory } from "@/hooks/use-extension-memory"
import type { CaptureSaveResult } from "@/hooks/use-extension-memory"
import type { ConversationInput } from "@/lib/conversations/types"
import type { ConversationSave } from "@/lib/conversations/save"
import type { NoteDraft } from "@/lib/notes/compose"
import type { KnowledgeItemRef } from "@/lib/memory/items"
import { ProjectActionsProvider } from "@/components/project/project-actions"
import type { ProjectActions } from "@/components/project/project-actions"
import { TabInput } from "@/components/tab-input"
import { useNow } from "@/hooks/use-now"
import type { NewProjectBrief } from "@/components/workspace/new-workspace-dialog"
import { parseWorkspaceExport } from "@/lib/workspace/json-import"
import { applyCategoryChange, ensureSectionsSeededInStore, syncSectionsWithCategoriesInStore } from "@/lib/sections/migrate"
import { organizeTabsCollectively } from "@/lib/sections/ai/pipeline"
import type { PipelineResult, PipelineStage } from "@/lib/sections/ai/pipeline"
import { logOrganizeReport, summarizeReportForToast } from "@/lib/sections/ai/report"
import type { OrganizeReport } from "@/lib/sections/ai/report"
import type { Section } from "@/lib/sections/types"
import { mergeDependencies } from "@/lib/dependencies/relations"
import { loadDependencyState, pruneDependencyState, saveDependencyState } from "@/lib/dependencies/persistence"
import { loadCollectionState, pruneCollectionState, saveCollectionState } from "@/lib/collections/persistence"
import { useTitleResolution } from "@/hooks/use-title-resolution"
import { useExtensionImport } from "@/hooks/use-extension-import"
import type { ExtensionImportResult, ExtensionImportTarget } from "@/hooks/use-extension-import"
import { useExtensionWorkspaceQuery } from "@/hooks/use-extension-workspace-query"
import { useExtensionQuickAdd } from "@/hooks/use-extension-quick-add"
import { useDesktopImport } from "@/hooks/use-desktop-import"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { desktopImport } from "@/lib/platform"
import { outcomeFromIngestion, type DesktopConversationRequest, type DesktopImportRequest, type DesktopTabsRequest } from "@/lib/desktop/import-protocol"
import { createSession } from "@/lib/sessions/model"
import { describeWriteError } from "@/lib/sessions/messages"
import { writeSessions } from "@/lib/sessions/persistence"
import { DesktopImportDialog, type DesktopImportChoice } from "@/components/desktop-import-dialog"
import { useOrganizationReadiness } from "@/hooks/use-organization-readiness"
import { OrganizationStatusBar } from "@/components/organization-preparation"
import { useOptionalAuth } from "@/components/auth/auth-provider"
import { useSyncEngine, useWorkspaceSyncState } from "@/hooks/use-sync-engine"
import { SyncIndicator } from "@/components/sync/sync-indicator"
import { markDuplicates } from "@/lib/tabs"
import { stampChangedTabs } from "@/lib/tabs/touch"
import { createTimestamp } from "@/lib/timestamps"
import { buildTabsFromBrowserImport, type BrowserImportEntry } from "@/lib/tabs/browser-import"
import { applySmartToSubjects, describeApplied, undoSmartToSubjects } from "@/lib/organize/smart/apply"
import type { SmartProposal } from "@/lib/organize/smart/types"
import { useContextSync } from "@/hooks/use-context-intelligence"
import { ProjectContextStrip } from "@/components/intelligence/project-context-strip"
import { captureConversation } from "@/lib/intelligence/bridge"
import { acceptSuggestion, undoAcceptance } from "@/lib/intelligence/decisions"
import { getContextSnapshot, writeContext } from "@/lib/intelligence/persistence"
import { proposalFromSuggestion, type SuggestionEdits } from "@/lib/intelligence/proposal"
import { willSaveText } from "@/lib/intelligence/records"
import type { Suggestion } from "@/lib/intelligence/types"
import { OpenTabsOrganize } from "@/components/organize/open-tabs-organize"
import type { Tab } from "@/lib/tabs/types"
import type { CategoryId } from "@/lib/categories"
import type { SettingsSection } from "@/components/settings/appearance-settings-view"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"
import { openTab } from "@/lib/browser/open-tab"
import { CommandPalette } from "@/components/command-palette/command-palette"
import { createId } from "@/lib/id"
import { CommandPaletteHostContext, type CommandPaletteHost } from "@/components/command-palette/palette-host"
import { buildGlobalCommands, mergeCommands } from "@/components/command-palette/global-commands"
import type { Command } from "@/components/command-palette/types"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { exposeLoopSummary, recordLoopMilestone, recordWorkspaceVisit } from "@/lib/product/loop-log"
import { useOptionalAppearanceContext } from "@/components/appearance-provider"

/**
 * Where a committed store came from.
 *
 * "local" is a user action and is reported to the sync engine. "remote" is
 * data the server just sent, already synchronized by definition — reporting
 * it would push it straight back, which is the loop the engine is built to
 * avoid.
 */
type CommitOrigin = "local" | "remote"

const SIDEBAR_COLLAPSED_KEY = "tabdump:sidebar-collapsed:v1"
const RECENTLY_ADDED_DURATION_MS = 6000
/** Stable while the store loads, so the transcript search's memo holds. */
const NO_WORKSPACES: Workspace[] = []

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0")
  } catch {
    // Non-critical UI preference — nothing to recover if storage is unavailable.
  }
}

/**
 * Whether the organization pipeline ran to completion. Distinguishing this
 * from "returned no report" matters now that readiness is gated on it: a
 * pipeline that threw must reach the error state, not quietly hand the user
 * a graph built from half-organized tabs.
 */
type OrganizeOutcome = { ok: true; report: OrganizeReport | undefined } | { ok: false; error: unknown }

const IMPORT_FAILURE_MESSAGES: Record<string, string> = {
  "invalid-json": "That file isn't valid JSON.",
  "invalid-schema": "That file doesn't look like a Hubble export. (To import AI conversations, open a project and choose Add → Import AI chats.)",
  "unsupported-version": "That export was made with a newer version of Hubble.",
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * A new subject in a store: a new workspace — or, while the store holds only
 * the untouched default every install starts with, that one, named. Either
 * way the subject is current afterwards. (The default is never shown as a
 * subject — see visibleSubjects — so this is the student's first subject,
 * not a second one beside an empty "General".)
 */
function createSubjectIn(current: WorkspaceStore, name: string, started: boolean): WorkspaceStore {
  // Once subjects have started, an empty "General" is the student's own subject — never reused.
  const lone = !started && current.workspaces.length === 1 && isPristineDefault(current.workspaces[0]!) ? current.workspaces[0]! : null
  if (!lone || !name.trim()) return createWorkspace(current, name)
  return switchWorkspace(renameWorkspace(current, lone.id, name), lone.id)
}

export function AppShell() {
  const [store, setStore] = useState<WorkspaceStore | null>(null)
  const [hydrated, setHydrated] = useState(false)
  // Has this visitor engaged with Hubble at all — connected the extension, or
  // explicitly chosen to skip onboarding? Decides whether `/` shows the public
  // landing page or the app (see the branch before this shell's return).
  // Defaults to true, the conservative answer: the app, not a marketing page,
  // is what an unknown visitor gets if this never resolves. Read post-mount
  // alongside the store below, for the same localStorage reason — never during
  // render.
  const [onboarded, setOnboarded] = useState(true)
  // Whether a subject has ever been made here (see visibleSubjects). Read post-mount, like the store.
  const [subjectsStarted, setSubjectsStarted] = useState(false)
  const [canPersist, setCanPersist] = useState(true)
  /*
    Home is where Hubble opens: the person's projects. "workspace" is a
    project's page; "search" searches every project. Everything else is
    reached from the rail, the palette or a link.
  */
  const [view, setView] = useState<"home" | "search" | "workspace" | "graph" | "ai" | "library" | "settings" | "favorites" | "recents" | "history-dump" | "sessions">("home")
  /** A node the Graph selects when it opens ("Show in graph"). */
  const [graphFocus, setGraphFocus] = useState<{ nodeId: string; nonce: number } | undefined>(undefined)
  /**
   * Which settings section the next visit to Settings opens on.
   *
   * Held here rather than inside the settings view because the surfaces that
   * deep-link into it live out here — an AI connector's approval link, the
   * palette's "AI apps". Cleared to undefined by the
   * ordinary Settings entry points, so the sidebar's Settings button keeps
   * landing where it always has.
   */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  /** Where Settings' Back returns to. */
  const [settingsReturn, setSettingsReturn] = useState<Exclude<typeof view, "settings">>("home")

  /** "Use in AI chat": the context builder, open on one project with these items chosen. */
  const [reuse, setReuse] = useState<{ workspaceId: string; refs: KnowledgeItemRef[]; provider?: AiProviderId; nonce: number } | null>(null)
  /** The capture dialog: write a note, import a file — into one project. */
  const [capture, setCapture] = useState<{ workspaceId: string; mode: CaptureMode; nonce: number } | null>(null)
  /** How to save AI conversations with Hubble for Chrome, from the command palette. */
  const [saveFromAiOpen, setSaveFromAiOpen] = useState(false)
  /** What the Search page opens with (a query from the palette, a project's scope). */
  const [searchStart, setSearchStart] = useState<{ query: string; workspaceId?: string; nonce: number }>({ query: "", nonce: 0 })
  // Each entry to Sessions remounts it; `save` opens "Save current session" there (Home's first-session prompt).
  const [sessionsStart, setSessionsStart] = useState<{ save: boolean; nonce: number }>({ save: false, nonce: 0 })
  /** An item to open on a project's page (from Search or Home), at a conversation's turn when given. */
  const [focusItem, setFocusItem] = useState<{ workspaceId: string; ref: KnowledgeItemRef; turn?: number; terms?: readonly string[]; nonce: number } | null>(null)
  // The local loop log: coming back to Hubble is a return — counted at most once per half hour, never sent anywhere.
  useEffect(() => {
    exposeLoopSummary()
    recordWorkspaceVisit()
  }, [])

  /**
   * Opening Settings from somewhere that knows which section it wants.
   *
   * The view is keyed on the section, so each deep link remounts it:
   * `initialSection` is an initial value, and without a fresh mount a second
   * jump to a different section would be ignored by the state that already
   * holds the first one.
   */
  function openSettings(section?: SettingsSection) {
    setSettingsSection(section)
    // Back goes where Settings was opened from: Projects, a project, Search…
    if (view !== "settings") setSettingsReturn(view)
    setView("settings")
  }
  /*
    `/?settings=ai-integrations` — the link an AI client is given when it
    proposes a change, so the person lands on the approval. Read once on
    mount and removed from the address bar; only that one section is
    honoured, and opening it changes nothing by itself.
  */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("settings") !== "ai-integrations") return
    params.delete("settings")
    const rest = params.toString()
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`)
    // A one-shot read of the address the person arrived at.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettingsSection("ai-integrations")
    setView("settings")
  }, [])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Below the `md` breakpoint the sidebar is an off-canvas drawer, closed by
  // default — distinct from `sidebarCollapsed` (the desktop icon-rail
  // toggle), which has no meaningful effect on mobile.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  /*
    The command palette belongs to the shell so ⌘K works on every
    destination. Views contribute their own commands through the host while
    mounted (see command-palette/palette-host.tsx); the shell adds the
    global set — navigation, knowledge, projects, every saved tab, settings.
  */
  const [paletteOpen, setPaletteOpen] = useState(false)
  // What the mounted views had contributed at the moment the palette opened.
  // Read from the ref in the opening event, never during render.
  const [contributedCommands, setContributedCommands] = useState<Command[][]>([])
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false)
  const contributedCommandsRef = useRef(new Map<string, Command[]>())
  // What was said in every project's videos, loaded only while the palette is open.
  const searchMoments = useTranscriptSearch(store?.workspaces ?? NO_WORKSPACES, paletteOpen)
  const paletteHost = useMemo<CommandPaletteHost>(
    () => ({
      open: () => {
        setContributedCommands([...contributedCommandsRef.current.values()])
        setPaletteOpen(true)
      },
      contribute: (source, commands) => {
        if (commands) contributedCommandsRef.current.set(source, commands)
        else contributedCommandsRef.current.delete(source)
      },
    }),
    []
  )
  const appearance = useOptionalAppearanceContext()
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        paletteHost.open()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [paletteHost])
  // Ids from the most recently completed import batch, for the "recently
  // added" tab-card treatment — ephemeral UI-only state (never persisted,
  // no Tab field backs it), cleared automatically after a short window so
  // it can never survive a reload or linger indefinitely.
  const [recentlyAddedIds, setRecentlyAddedIds] = useState<Set<string>>(new Set())
  const recentlyAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Snapshot of the store immediately before the most recent import-type
  // mutation (initial paste dump, extension import). A ref rather than
  // state: it's only ever read inside the toast's "Undo" click handler, so
  // it doesn't need to drive a render on its own. Identity (not just value)
  // equality against this ref is how "only the latest import is undoable"
  // is enforced — see notifyImported.
  const undoSnapshotRef = useRef<WorkspaceStore | null>(null)
  // Smart Organize for the tabs open in Chrome (Home, ⌘K).
  const [organizeOpenTabs, setOrganizeOpenTabs] = useState(false)
  // The project a bulk import just landed in: it offers Smart Organize once,
  // as a quiet line the person can take or dismiss (see WorkspaceView).
  // `token` tells one import from the next, so a second import into the same project offers afresh.
  const [organizeOfferFor, setOrganizeOfferFor] = useState<{ workspaceId: string; token: number } | null>(null)
  // Sources the person gave content to this session (an uploaded PDF, a pasted
  // transcript). Nothing on the tab record says so, and an Undo of Smart
  // Organize must never take that content away (see undoSmartToSubjects).
  const suppliedContentRef = useRef<Set<string>>(new Set())
  // The dump → classify → "Other" → layout → settle lifecycle, and the only
  // thing that decides whether the Graph View can be entered. See
  // lib/organize/lifecycle.ts.
  const readiness = useOrganizationReadiness()
  // The last dump's inputs, so the error state's "Try again" can re-run
  // exactly the same organization rather than asking the user to re-dump.
  const lastDumpRef = useRef<{ workspaceId: string; tabs: Tab[]; sections: Section[] } | null>(null)
  // The latest COMMITTED store — the value most recently handed to
  // `commitStore`, or hydrated on mount. Deliberately not a snapshot of
  // whatever `store` this render happens to see:
  //
  //  - the settle effect must read the store as it is AFTER the pipeline
  //    merged its result, without re-running every time an unrelated update
  //    (a resolved title) lands mid-settle;
  //  - async callbacks that resolve out of order need "today's latest
  //    store", which is exactly what a functional setState updater gave
  //    them — and this ref is how they keep that guarantee now that they no
  //    longer run inside one (see commitStore).
  //
  // Assigning it during render instead would reintroduce a stale read: a
  // re-render triggered by some OTHER piece of state between a commit and
  // the store's own re-render would write the pre-commit `store` back over
  // it. Only commitStore and hydration touch it, and they are the only two
  // places that call setStore, so it cannot drift.
  const storeRef = useRef<WorkspaceStore | null>(null)
  // Whether the last commit reached localStorage. A save that tells someone
  // else it is done — a conversation from Hubble for Chrome — checks this
  // rather than trusting that a commit is a write: a full or unavailable
  // localStorage leaves the change in memory only, gone on the next reload.
  const lastCommitPersistedRef = useRef(true)

  // Optional rather than required: this component renders in unit tests that
  // mount it without an AuthProvider, and signed-out is a normal state.
  // A null user disables sync entirely — see the engine's markDirty.
  const auth = useOptionalAuth()

  /**
   * The sync engine.
   *
   * Sits ALONGSIDE the local architecture, not inside it: it is handed
   * already-committed state and decides on its own when to talk to the
   * server. `commitStore` stays synchronous, deterministic and local, and
   * nothing below can fail it.
   *
   * Collections and dependencies are read from their own localStorage stores
   * rather than from React state, because they live in hooks mounted further
   * down the tree (WorkspaceView, the Graph) and are not available here.
   */
  const sync = useSyncEngine({
    userId: auth?.user?.id ?? null,
    store,
    getCollections: (workspaceId) =>
      loadCollectionState().collections.filter((c) => c.workspaceId === workspaceId),
    getDependencies: () => loadDependencyState().dependencies,
    onRemoteWorkspace: (workspace) => {
      const current = storeRef.current
      if (!current) return
      // Appended when this device has never seen it — which is exactly what
      // adopting a workspace from another device does. Replacing in place
      // only would have quietly dropped it, leaving adoption reporting
      // success with nothing to show for it.
      const known = current.workspaces.some((w) => w.id === workspace.id)
      const workspaces = known
        ? current.workspaces.map((w) => (w.id === workspace.id ? workspace : w))
        : [...current.workspaces, workspace]
      // Through the ordinary seam, flagged remote so it is not re-uploaded.
      commitStore({ ...current, workspaces }, "remote")
    },
  })

  useEffect(() => {
    // Hydrating from localStorage: this can only run post-mount (SSR has no
    // access to it, and reading it during render would cause a hydration
    // mismatch), so there is no way to derive this during render instead —
    // it's exactly the "synchronize with an external system on mount" case
    // effects exist for, not the derived-state anti-pattern this rule targets.
    const available = isStorageAvailable()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanPersist(available)
    const migrated = migrateToWorkspaceStore()
    // One-time, idempotent: seeds a root section per legacy category for any
    // workspace that predates sections (spec §26) — never reorganizes a tab
    // that already has one. ensureSectionsSeededInStore always returns a new
    // top-level object, so only persist when a workspace actually changed.
    const seeded = ensureSectionsSeededInStore(migrated)
    // Heals any workspace whose sections had already drifted from its tabs'
    // flat categories before this fix existed (e.g. a tab recategorized
    // without ever going through a dump/import) — see
    // syncSectionsWithCategories's doc comment for why that drift happens.
    const synced = syncSectionsWithCategoriesInStore(seeded)
    const changedOnLoad = synced.workspaces.some((w, i) => w !== migrated.workspaces[i])
    // Seeds the committed-store ref alongside the state itself; see
    // storeRef's comment for why nothing assigns it during render.
    storeRef.current = synced
    setStore(synced)
    // Deliberately NOT commitStore: this is load-time migration, not a user
    // mutation, so it writes only when a workspace actually changed and it
    // reads `available` directly rather than the `canPersist` state this
    // same effect is still in the middle of setting.
    if (available && changedOnLoad) saveWorkspaceStore(synced)
    setSidebarCollapsed(loadSidebarCollapsed())
    setSubjectsStarted(loadSubjectsStarted())
    const onboarding = getOnboardingState()
    // `available` gates this: with no localStorage there is no way to tell a
    // first-time visitor from a returning one, and getOnboardingState's default
    // would answer "first time" on every single load — trapping someone behind
    // the landing page on every visit forever. Unknown resolves to onboarded,
    // i.e. the app.
    setOnboarded(!available || onboarding.dismissed || onboarding.extensionConnected)
    if (!available) {
      toast.info("Your projects won't be saved between visits", {
        description: "Local storage isn't available in this browser.",
      })
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    return () => {
      if (recentlyAddedTimerRef.current) clearTimeout(recentlyAddedTimerRef.current)
    }
  }, [])

  /*
    Other Hubble tabs. Every tab holds the whole store in memory and writes all
    of it on each commit, so without this a second tab kept its own stale copy:
    the extension, asking whichever Hubble tab it found, missed a project made
    in another one until that tab was reloaded — and the stale tab's next
    commit wrote over whatever the other had saved meanwhile (a conversation
    from Hubble for Chrome among them). Now another tab's write is taken here
    as it lands: the `storage` event fires in every other same-origin tab.

    Taken, not committed: writing it back would bounce between tabs, and the
    sync engine already heard of it from the tab that made it. The project on
    screen stays this tab's own unless it was deleted there.
  */
  useEffect(() => {
    if (!hydrated) return
    function onStorage(event: StorageEvent) {
      if (event.storageArea !== window.localStorage || event.key !== workspaceStoreStorageKey() || event.newValue === null) return
      const current = storeRef.current
      const incoming = loadWorkspaceStore()
      if (!current || !incoming) return
      const keepCurrent = current.currentId !== incoming.currentId && incoming.workspaces.some((workspace) => workspace.id === current.currentId)
      const adopted = keepCurrent ? { ...incoming, currentId: current.currentId } : incoming
      storeRef.current = adopted
      setStore(adopted)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [hydrated])

  // Every mutation flows through here, so this is the single chokepoint that
  // keeps root sections aligned with each tab's flat category — see
  // syncSectionsWithCategories's doc comment for why that can otherwise
  // drift (recategorizing a tab, or bulk-recategorizing a selection, never
  // goes through the async AI/fallback organizer that dumps/imports do).
  // Idempotent and referentially stable per-workspace when nothing needs
  // fixing, so this adds no meaningful overhead to the common case.
  function persist(next: WorkspaceStore): WorkspaceStore {
    return commitStore(syncSectionsWithCategoriesInStore(next))
  }

  /**
   * Commits an already-computed store: records it, hands it to React, and
   * writes it to localStorage exactly once.
   *
   * This is the whole persistence seam. It takes a finished value rather
   * than a reducer, so nothing here ever runs inside a React state updater.
   * That matters because React invokes updaters an unpredictable number of
   * times — twice per update under StrictMode in development — and an
   * updater that persists or reads the clock therefore writes to
   * localStorage twice and can mint two different timestamps, keeping the
   * one React happens to retain. Phase 2 saw exactly that as a 1ms drift
   * between committed state and stored state.
   *
   * Callers that need "the latest store" rather than the one their closure
   * captured read `storeRef.current`, which this keeps current
   * synchronously — so two async callbacks resolving in the same tick still
   * compose, the way nesting them in functional updaters used to guarantee.
   */
  function commitStore(next: WorkspaceStore, origin: CommitOrigin = "local"): WorkspaceStore {
    const previous = storeRef.current
    storeRef.current = next
    setStore(next)
    lastCommitPersistedRef.current = canPersist ? saveWorkspaceStore(next) : false

    // Synchronization is notified AFTER the commit has already succeeded,
    // and cannot affect it. Still synchronous and still not async: this
    // records what changed and schedules work on a timer, it does not make
    // a request. `commitStore` stays the deterministic local seam Phase 2.5
    // established.
    //
    // `origin` is what stops a pull from becoming a push. A commit carrying
    // remote data marks nothing dirty, so applying a remote change can never
    // enqueue that same change for upload.
    if (origin === "local") {
      try {
        sync.notifyLocalCommit(previous, next)
      } catch {
        // A failure in bookkeeping must never cost the user their edit: the
        // workspace is already persisted by the time this runs.
      }
    }
    return next
  }

  // Device-local UI state rather than workspace data, but the same rule
  // applies: compute the next value, then set and save it — never save from
  // inside the updater, where React is free to evaluate more than once.
  function toggleSidebarCollapsed() {
    const next = !sidebarCollapsed
    setSidebarCollapsed(next)
    saveSidebarCollapsed(next)
  }

  function markRecentlyAdded(ids: string[]) {
    if (ids.length === 0) return
    setRecentlyAddedIds(new Set(ids))
    if (recentlyAddedTimerRef.current) clearTimeout(recentlyAddedTimerRef.current)
    recentlyAddedTimerRef.current = setTimeout(() => {
      setRecentlyAddedIds(new Set())
    }, RECENTLY_ADDED_DURATION_MS)
  }

  function notifyImported(count: number) {
    const snapshot = undoSnapshotRef.current
    toast(`${count} tab${count === 1 ? "" : "s"} imported`, {
      action: {
        label: "Undo",
        onClick: () => {
          // Only acts if no later import has superseded this one — an
          // older toast's Undo becoming a no-op once a newer import has
          // landed is what keeps "only the latest import" true even when
          // more than one toast is still on screen.
          if (!snapshot || undoSnapshotRef.current !== snapshot) return
          persist(snapshot)
          undoSnapshotRef.current = null
        },
      },
    })
  }

  function handleDump(tabs: Tab[]) {
    if (!store) return
    const current = getCurrentWorkspace(store)
    undoSnapshotRef.current = store
    const next = updateWorkspaceTabs(store, current.id, tabs)
    // persist() runs syncSectionsWithCategoriesInStore, which can seed brand
    // new root sections (one per legacy category newly present in `tabs`) —
    // use ITS returned, already-synced store (not the pre-sync `next`) below,
    // so the AI pipeline sees those roots already in place and reuses them
    // via findSimilarSibling instead of creating same-named duplicates.
    const synced = persist(next)
    markRecentlyAdded(tabs.map((t) => t.id))
    notifyImported(tabs.length)
    setOrganizeOfferFor({ workspaceId: getCurrentWorkspace(next).id, token: Date.now() })
    const nextWorkspace = getCurrentWorkspace(synced)
    // Snapshot from `nextWorkspace.tabs` (post-persist/post-sync), not the
    // raw `tabs` param — syncSectionsWithCategoriesInStore inside persist()
    // just gave every non-"other"-category tab a coarse category-root
    // sectionId synchronously, before this async call even starts. Snapshotting
    // the PRE-sync value here would make organizeNewTabsIntoSections's own
    // drift guard see that sync-assigned id as "drift" the moment this
    // resolves and discard the pipeline's real placement for every single
    // categorized tab, every single dump — starting from the already-synced
    // value means the guard only fires for drift that happens DURING the
    // async window (a genuine concurrent user edit), which is what it's for.
    const generation = readiness.begin(nextWorkspace.tabs.length)
    runDumpOrganization(generation, nextWorkspace.id, nextWorkspace.tabs, nextWorkspace.sections ?? [])
  }

  function handleTabsChange(tabs: Tab[]) {
    if (!store) return
    persist(updateWorkspaceTabs(store, getCurrentWorkspace(store).id, tabs))
  }

  // Favorites/Recents render as siblings of WorkspaceView rather than inside
  // it, so they need their own copies of the same small per-tab mutations
  // WorkspaceView already has (handleCategoryChange/handleToggleFavorite/
  // handleOpenTab/handleNotesChange there) — all of them funnel through the
  // same handleTabsChange → persist path, just scoped from currentWorkspace
  // instead of WorkspaceView's local `tabs` prop.
  function handleCategoryChangeInView(id: string, category: CategoryId) {
    if (!currentWorkspace) return
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? applyCategoryChange(t, category) : t)))
  }

  function handleToggleFavoriteInView(id: string) {
    if (!currentWorkspace) return
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? { ...t, isFavorite: !t.isFavorite } : t)))
  }

  function handleOpenTabInView(id: string) {
    if (!currentWorkspace) return
    const tab = currentWorkspace.tabs.find((t) => t.id === id)
    if (!tab) return
    openTab(tab.url)
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? { ...t, lastAccessedAt: Date.now() } : t)))
  }

  function handleNotesChangeInView(id: string, notes: string) {
    if (!currentWorkspace) return
    const trimmed = notes.trim()
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? { ...t, notes: trimmed || undefined } : t)))
  }

  // Title resolution runs asynchronously and may still be in flight if the
  // user switches workspaces before it resolves. Binding to the workspace
  // id captured when resolution *started*, and applying it to the latest
  // committed store (`storeRef.current`, not whatever `store` this closure
  // was created with), means a resolved title always lands back in the
  // workspace it was actually resolved for — never wherever the user
  // happens to be looking by the time the fetch completes.
  //
  // `tabs` is useTitleResolution's own snapshot, built from whatever tabs
  // looked like when its effect started — patching in just the `title`
  // field by id onto the workspace's CURRENT tabs (rather than replacing
  // the array with this stale snapshot wholesale) means a concurrent edit
  // to some other field (category, sectionId from organizeNewTabsIntoSections,
  // notes, ...) that landed while resolution was in flight survives instead
  // of being silently reverted by an unrelated title update.
  function handleTitlesResolved(workspaceId: string, tabs: Tab[]) {
    const prev = storeRef.current
    if (!prev) return
    const workspace = prev.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    const resolvedById = new Map(tabs.map((t) => [t.id, t]))
    const mergedTabs = workspace.tabs.map((t) => {
      const resolved = resolvedById.get(t.id)
      return resolved && resolved.title !== t.title ? { ...t, title: resolved.title } : t
    })
    commitStore(updateWorkspaceTabs(prev, workspaceId, mergedTabs))
  }

  // Runs the AI section-organization engine (src/lib/sections/ai/organize.ts)
  // over `tabsSnapshot` and merges the result back into whichever workspace
  // matching `workspaceId` looks like BY THE TIME THE CALL RESOLVES (read
  // from storeRef, same "always merge into the latest committed state"
  // pattern handleTitlesResolved uses) — never the stale `store` this
  // function's caller closed over. New sections are unioned in rather than
  // overwriting the workspace's current list, so a section the user created
  // while this was in flight survives. Tabs no longer present in the
  // workspace (deleted/moved meanwhile) are silently skipped. Deliberately
  // fire-and-forget from every call site: this NEVER blocks or fails a dump
  // (spec §28) — organizeTabsIntoSections itself never throws, and this
  // wrapper's own best-effort embedding-hint lookup is wrapped separately.
  async function organizeNewTabsIntoSections(
    workspaceId: string,
    tabsSnapshot: Tab[],
    sectionsSnapshot: Section[],
    onStage?: (stage: PipelineStage) => void
  ): Promise<OrganizeOutcome> {
    if (tabsSnapshot.length === 0) return { ok: true, report: undefined }

    // The pipeline's multi-stage clustering/naming can take several async
    // hops (more than the old single-shot organizeTabsIntoSections), so it's
    // more likely than before that a user manually recategorizes/moves a tab
    // (or locks it) while this is still in flight. Snapshotting each tab's
    // pre-pipeline sectionId lets the merge below detect that drift and skip
    // re-applying a now-stale AI placement onto it, instead of silently
    // clobbering whatever the user just did.
    const sectionIdBeforeById = new Map(tabsSnapshot.map((t) => [t.id, t.sectionId]))

    const workspaceName = store?.workspaces.find((w) => w.id === workspaceId)?.name ?? ""
    let result: PipelineResult
    try {
      result = await organizeTabsCollectively(workspaceId, workspaceName, tabsSnapshot, sectionsSnapshot, onStage)
    } catch (err) {
      // organizeTabsCollectively is designed to never throw (every AI/network
      // failure inside it degrades to a deterministic fallback instead) — but
      // if something unexpected still does, failing loudly here beats the
      // alternative: an unhandled rejection from this fire-and-forget async
      // function would silently vanish, leaving every one of these tabs
      // exactly as un-sectioned as they were the moment they were dumped.
      console.error("[organize] pipeline threw unexpectedly — tabs left unorganized:", err)
      return { ok: false, error: err }
    }
    logOrganizeReport(result.report)

    const prev = storeRef.current
    if (!prev) return { ok: true, report: result.report }
    const workspace = prev.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return { ok: true, report: result.report }

    const existingSectionIds = new Set((workspace.sections ?? []).map((s) => s.id))
    const newSections = result.sections.filter((s) => !existingSectionIds.has(s.id))
    const sections = [...(workspace.sections ?? []), ...newSections]

    const organizedById = new Map(result.tabs.map((t) => [t.id, t]))
    const tabs = workspace.tabs.map((t) => {
      const organized = organizedById.get(t.id)
      if (!organized) return t
      // sectionIdBeforeById always has an entry for any id also in
      // organizedById (both derive from the same tabsSnapshot), so a plain
      // !== comparison correctly treats "was undefined" as a real value
      // rather than "missing key".
      if (t.sectionId !== sectionIdBeforeById.get(t.id)) return t
      return organized
    })

    // Organization is a real mutation of the tabs it places: it writes
    // sectionId, organizationStatus and organizationReason. Those have to go
    // through stampChangedTabs like every other bulk tab write, or a tab that
    // the pipeline just filed would sync as older than its own placement.
    // One clock read for the workspace and its tabs, so a tab stamped by this
    // pass carries exactly the workspace's updatedAt — and it is read here,
    // at the point the mutation is actually performed, rather than inside a
    // state updater React may evaluate more than once.
    const now = createTimestamp()
    const workspaces = prev.workspaces.map((w) =>
      w.id === workspaceId
        ? { ...w, sections, tabs: stampChangedTabs(workspace.tabs, tabs, now), updatedAt: now }
        : w
    )
    commitStore({ ...prev, workspaces })

    return { ok: true, report: result.report }
  }

  /**
   * The whole dump lifecycle for one generation: organization, including the
   * slow "Other" tail. Every dump entry point goes through here, so there is
   * exactly one place where a dump can be declared finished — and it is
   * reached only when the pipeline's promise has actually resolved, never on
   * a timer. (There is no layout half any more: the Graph places tabs as
   * they arrive and never moves what it has placed.)
   */
  async function runDumpOrganization(
    generation: number,
    workspaceId: string,
    tabsSnapshot: Tab[],
    sectionsSnapshot: Section[]
  ): Promise<OrganizeOutcome> {
    lastDumpRef.current = { workspaceId, tabs: tabsSnapshot, sections: sectionsSnapshot }
    const outcome = await organizeNewTabsIntoSections(workspaceId, tabsSnapshot, sectionsSnapshot, (stage) =>
      readiness.advance(generation, stage)
    )
    if (!outcome.ok) {
      readiness.fail(generation, "Couldn't finish organizing your tabs.")
      return outcome
    }
    readiness.complete(generation)
    return outcome
  }

  function retryDumpOrganization() {
    const last = lastDumpRef.current
    if (!last) {
      readiness.dismissError()
      return
    }
    const generation = readiness.begin(last.tabs.length)
    runDumpOrganization(generation, last.workspaceId, last.tabs, last.sections)
  }

  function handleCreateSection(parentId: string | null, name: string) {
    if (!store || !currentWorkspace) return
    const result = createSectionInWorkspace(store, currentWorkspace.id, parentId, name, "user")
    if (!result) {
      toast.error("Couldn't create that section", {
        description: parentId ? "Sections can be nested at most 3 levels deep." : undefined,
      })
      return
    }
    persist(result.store)
  }

  function handleRenameSection(id: string, name: string) {
    if (!store || !currentWorkspace) return
    persist(renameSectionInWorkspace(store, currentWorkspace.id, id, name))
  }

  function handleDeleteSection(id: string, reassignToSectionId?: string) {
    if (!store || !currentWorkspace) return
    persist(deleteSectionInWorkspace(store, currentWorkspace.id, id, reassignToSectionId))
  }

  function handleAssignTabToSection(tabId: string, sectionId: string) {
    if (!store || !currentWorkspace) return
    persist(assignTabsToSection(store, currentWorkspace.id, [tabId], sectionId))
  }

  async function handleReorganizeSections() {
    if (!currentWorkspace) return
    const unlocked = currentWorkspace.tabs.filter((t) => !t.sectionLocked)
    if (unlocked.length === 0) {
      toast.info("Nothing to reorganize", { description: "Every tab here has been manually placed." })
      return
    }
    toast.info(`Reorganizing ${unlocked.length} tab${unlocked.length === 1 ? "" : "s"}…`)
    // Goes through the same lifecycle a dump does: a manual reorganize moves
    // tabs between sections, which restructures the graph exactly as a dump
    // would, so the graph has to stay shut until it too has settled.
    const generation = readiness.begin(unlocked.length)
    const outcome = await runDumpOrganization(generation, currentWorkspace.id, unlocked, currentWorkspace.sections ?? [])
    if (!outcome.ok) {
      toast.error("Couldn't reorganize these tabs")
      return
    }
    toast.success("Reorganized", { description: outcome.report ? summarizeReportForToast(outcome.report) : undefined })
  }

  const currentWorkspace = store ? getCurrentWorkspace(store) : null
  // Subscribes to the engine rather than mirroring its state into React —
  // the engine stays the single source of truth for sync status.
  const syncState = useWorkspaceSyncState(sync, currentWorkspace?.id ?? null)

  useTitleResolution(currentWorkspace?.tabs ?? [], (tabs) => {
    if (currentWorkspace) handleTitlesResolved(currentWorkspace.id, tabs)
  })

  // Tabs arriving from the browser extension go through the exact same
  // parsing/categorization the paste flow uses (buildTabsFromBrowserImport
  // wraps parseSingleUrl + categorizeTabs), then get merged into the
  // current workspace — `markDuplicates` runs over the combined list, so
  // cross-batch duplicates are still caught, not just duplicates within the
  // incoming batch. Merging into an empty workspace's tabs is just a fresh
  // dump, so no separate "first import" branch is needed.
  function notifyHistoryDumped(count: number, skipped: number) {
    const snapshot = undoSnapshotRef.current
    toast(`${count} tab${count === 1 ? "" : "s"} dumped`, {
      description: skipped > 0 ? `${skipped} ${skipped === 1 ? "was" : "were"} already in Hubble` : undefined,
      action: {
        label: "Undo",
        onClick: () => {
          if (!snapshot || undoSnapshotRef.current !== snapshot) return
          persist(snapshot)
          undoSnapshotRef.current = null
        },
      },
    })
  }

  // History Dump's own merge step (AGENTS.md section 36): unlike
  // handleBrowserImport, this filters out anything that already exists in
  // the current workspace *before* merging, rather than letting markDuplicates
  // flag it after the fact — History Dump's review screen already lets the
  // user see "already in Hubble" candidates, so nothing selected from there
  // should ever land as a second copy. Entries still funnel through the exact
  // same buildTabsFromBrowserImport ingestion the popup-driven dump uses.
  function handleHistoryDump(entries: BrowserImportEntry[]) {
    if (!store) return
    const incoming = buildTabsFromBrowserImport(entries)
    if (incoming.length === 0) return

    const current = getCurrentWorkspace(store)
    const existingNormalized = new Set(current.tabs.map((t) => t.normalizedUrl))
    const fresh = incoming.filter((t) => !existingNormalized.has(t.normalizedUrl))
    const skipped = incoming.length - fresh.length

    if (fresh.length === 0) {
      toast.info("Nothing new to add", { description: "All selected pages are already in Hubble." })
      setView("workspace")
      return
    }

    undoSnapshotRef.current = store
    const merged = markDuplicates([...current.tabs, ...fresh])
    const next = updateWorkspaceTabs(store, current.id, merged)
    // See handleDump's comment: use persist()'s synced return value, not the
    // pre-sync `next`, so newly-seeded root sections are visible to the AI
    // pipeline instead of it creating same-named duplicates.
    const synced = persist(next)
    markRecentlyAdded(fresh.map((t) => t.id))
    notifyHistoryDumped(fresh.length, skipped)
    setOrganizeOfferFor({ workspaceId: getCurrentWorkspace(next).id, token: Date.now() })
    const nextWorkspace = getCurrentWorkspace(synced)
    // Re-resolve the just-dumped tabs from the post-merge workspace (not the
    // pre-merge `fresh` array) so their markDuplicates-assigned `isDuplicate`
    // flag survives — organizeNewTabsIntoSections completely replaces each
    // organized tab object with whatever it's given.
    const freshIds = new Set(fresh.map((t) => t.id))
    const dumped = nextWorkspace.tabs.filter((t) => freshIds.has(t.id))
    const generation = readiness.begin(dumped.length)
    runDumpOrganization(generation, nextWorkspace.id, dumped, nextWorkspace.sections ?? [])
    setView("workspace")
  }

  /**
   * Returns how many tabs were actually taken, which the extension acks on
   * and reports to the user — see useExtensionImport. A silent `return` here
   * used to become a dump the popup happily called a success, so every exit
   * path has to answer with a real number.
   */
  function handleBrowserImport(entries: BrowserImportEntry[], target?: ExtensionImportTarget): ExtensionImportResult {
    // "Add to project" from the extension (Hubble 2.0): the same source pipeline as a drop, into the project the person chose.
    if (target) {
      if (!storeRef.current?.workspaces.some((workspace) => workspace.id === target.workspaceId)) return { accepted: 0, duplicates: 0, projectMissing: true }
      const outcomes = handleAddSources(
        target.workspaceId,
        entries.map((entry) => ({ url: entry.url, ...(entry.title ? { title: entry.title } : {}), ...(entry.favicon ? { favicon: entry.favicon } : {}) })),
        "extension"
      )
      return {
        accepted: outcomes.filter((outcome) => outcome.status === "added" || outcome.status === "adopted").length,
        duplicates: outcomes.filter((outcome) => outcome.status === "duplicate").length,
      }
    }
    // Defense in depth: useExtensionImport only forwards a batch once
    // `extensionCanIngest` below is true, which already implies a hydrated
    // store. Answering 0 (rather than nothing) keeps even an impossible
    // ordering honest instead of silently successful.
    if (!store) return 0
    const incoming = buildTabsFromBrowserImport(entries)
    if (incoming.length === 0) return 0

    const current = getCurrentWorkspace(store)
    undoSnapshotRef.current = store
    const merged = markDuplicates([...current.tabs, ...incoming])
    const next = updateWorkspaceTabs(store, current.id, merged)
    // See handleDump's comment: use persist()'s synced return value, not the
    // pre-sync `next`, so newly-seeded root sections are visible to the AI
    // pipeline instead of it creating same-named duplicates.
    const synced = persist(next)
    markRecentlyAdded(incoming.map((t) => t.id))
    notifyImported(incoming.length)
    setOrganizeOfferFor({ workspaceId: getCurrentWorkspace(next).id, token: Date.now() })
    const nextWorkspace = getCurrentWorkspace(synced)
    const incomingIds = new Set(incoming.map((t) => t.id))
    const imported = nextWorkspace.tabs.filter((t) => incomingIds.has(t.id))
    const generation = readiness.begin(imported.length)
    runDumpOrganization(generation, nextWorkspace.id, imported, nextWorkspace.sections ?? [])
    // From Home or AI, land on the subject the tabs went into, so they are seen arriving (as a Desktop import does).
    // Anywhere else — the Graph above all, where they arrive in their project's fan — stays put.
    setView((current) => (current === "home" || current === "search" ? "workspace" : current))
    // Organization is gated and asynchronous, but the ack is not: the count
    // answers "how many tabs did this shell take", which is settled the
    // moment they are merged and persisted above. See this function's
    // contract — a silent return here is a dump the popup calls a success.
    return incoming.length
  }

  // Gates the extension's import handshake on this shell being able to
  // actually take a batch. The extension delivers the moment Chrome reports
  // the tab `complete`, which is measurably *before* React finishes
  // hydrating — so without this signal a dump landing on a freshly opened
  // tab was posted into a document with nothing listening and silently lost.
  // The content script holds the payload until this flips true.
  const extensionCanIngest = hydrated && store !== null && currentWorkspace !== null
  // The projects the extension popup may offer for "Add to project": names and counts only.
  const extensionProjects = useMemo(
    () => (store ? store.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, sources: workspace.tabs.filter((tab) => tab.resource).length })) : []),
    [store]
  )
  useExtensionImport(handleBrowserImport, extensionCanIngest)
  // Hubble for Chrome's memory requests: projects, saving a captured conversation, search, context.
  useExtensionMemory(
    {
      getStore: () => storeRef.current,
      saveCapture: (workspaceId, input, truncated) => saveCapturedConversation(workspaceId, input, truncated),
      onReused: ({ workspaceId, items, provider, how }) => {
        recordLoopMilestone(how === "inserted" ? "memory_inserted" : "memory_copied", provider ? { provider } : {})
        recordProjectEvent({ workspaceId, kind: "memory_reused", count: items, ...(provider ? { provider } : {}) })
      },
    },
    extensionCanIngest
  )
  useExtensionWorkspaceQuery(currentWorkspace?.tabs ?? [], extensionProjects)
  // Quick add: the extension's tab-strip menu and shortcut add to the project on screen.
  const quickAdd = useExtensionQuickAdd({ workspaces: store?.workspaces, currentWorkspaceId: currentWorkspace?.id })
  // Chrome → Hubble Desktop (handleDesktopImport below): tabs and conversations the extension sent straight to this app.
  const isDesktopShell = useIsDesktop()
  // Context intelligence (lib/intelligence): pulls detected activity from Hubble for Chrome and keeps the
  // suggestions current. Web only — Hubble Desktop can't reach the extension.
  const contextWorkspaces = useMemo(() => (store ? visibleSubjects(store, subjectsStarted) : []), [store, subjectsStarted])
  useContextSync({ workspaces: contextWorkspaces, enabled: hydrated && store !== null && !isDesktopShell })
  const browserConnected = useBrowserConnected()
  const desktopImports = useDesktopImport(
    isDesktopShell ? desktopImport() : undefined,
    hydrated && store !== null,
    (request) =>
      request.kind === "conversation"
        ? toast.info("The conversation from Chrome wasn't saved", { description: "No project was chosen in time. Save it again from Chrome." })
        : toast.info("Tabs from Chrome weren't added", { description: "No project was chosen in time. Add them again from Chrome." }),
    // A conversation from Chrome: the same save as the extension's Save on the web.
    (workspaceId, input, truncated) => saveCapturedConversation(workspaceId, input, truncated)
  )

  /*
    Project sources (Hubble 2.0): read in the background, written back
    through the one commit seam against the latest committed store.
  */
  const resources = useResourceProcessing({
    store,
    getStore: () => storeRef.current,
    commit: (next) => {
      commitStore(next)
    },
    enabled: hydrated,
  })
  const fileUploads = useFileUploads({
    store,
    getStore: () => storeRef.current,
    commit: (next) => {
      commitStore(next)
    },
    enabled: hydrated,
  })
  // What the subject page gets: the same actions, noting which sources the person supplied content for.
  const sourceActions: typeof resources = {
    ...resources,
    attachPdf: (workspaceId, tabId, file) => {
      suppliedContentRef.current.add(tabId)
      return resources.attachPdf(workspaceId, tabId, file)
    },
    attachTranscript: (workspaceId, tabId, text) => {
      suppliedContentRef.current.add(tabId)
      return resources.attachTranscript(workspaceId, tabId, text)
    },
  }
  const now = useNow(60_000)

  function workspaceNamed(id: string): string {
    const workspace = storeRef.current?.workspaces.find((entry) => entry.id === id)
    return workspace ? subjectName(workspace) : "this project"
  }

  /**
   * The one way sources enter a project — a Chrome drop, the Add source
   * dialog, the extension's "Add to project", an existing tab. Returns each
   * input's outcome; says what happened in one toast with an exact undo.
   */
  function handleAddSources(workspaceId: string, inputs: ResourceInput[], origin: ResourceOrigin): IngestOutcome[] {
    const before = storeRef.current
    if (!before) return []
    const result = ingestResources(before, workspaceId, inputs, origin, createTimestamp())
    if (!result) return []
    const counts = describeIngestion(result.plan)
    const name = workspaceNamed(workspaceId)
    if (result.store !== before) {
      persist(result.store)
      recordProjectEvent({ workspaceId, kind: "sources_added", count: counts.added, origin })
      recordLoopMilestone("resource_added")
    }
    notifySourcesAdded(workspaceId, name, result.plan, counts)
    return result.plan.outcomes
  }

  /*
    Chrome → Hubble Desktop: tabs and AI conversations the extension sent
    straight to this app (src-tauri/src/import_bridge.rs). Rust holds each
    request until this store can take it; the person picks a project in
    DesktopImportDialog. A batch of tabs goes through handleAddSources — the
    same pipeline, duplicate rule, persistence and toast as a drop or the
    extension's "Add to project" on the web. A conversation goes through
    saveCapturedConversation — the same save, duplicate rule and toast as the
    extension's Save on the web. Nothing on the web: there is no bridge there.
  */
  function handleDesktopImport(request: DesktopImportRequest, choice: DesktopImportChoice): boolean | Promise<boolean> {
    if ("session" in choice) return request.kind === "tabs" ? saveDesktopSession(request, choice.session) : false
    let latest = storeRef.current
    if (!latest) return false
    let workspaceId: string
    if ("newProject" in choice) {
      latest = persist(createSubjectIn(latest, choice.newProject, subjectsStarted))
      workspaceId = latest.currentId
      markSubjectsStarted()
      setSubjectsStarted(true)
      recordLoopMilestone("project_created")
      recordProjectEvent({ workspaceId, kind: "project_created" })
    } else {
      if (!latest.workspaces.some((workspace) => workspace.id === choice.workspaceId)) return false
      workspaceId = choice.workspaceId
    }
    if (request.kind === "conversation") return saveDesktopConversation(request, workspaceId)
    const outcomes = handleAddSources(workspaceId, request.tabs, "extension")
    desktopImports.answer(request.requestId, outcomeFromIngestion(request, outcomes, workspaceNamed(workspaceId)))
    showDesktopImportProject(workspaceId)
    return true
  }

  /**
   * Tabs from Chrome kept as a session rather than added to a project — how
   * Hubble Desktop saves one, since it can't read Chrome's open tabs itself.
   * The same createSession and limits as Save current session on the web.
   */
  function saveDesktopSession(request: DesktopTabsRequest, name: string): boolean {
    const tabs = request.tabs.map((tab) => ({ url: tab.url, ...(tab.title ? { title: tab.title } : {}), ...(tab.favicon ? { favicon: tab.favicon } : {}) }))
    const result = writeSessions((state) => createSession(state, { name, tabs }, { now: createTimestamp(), mintId: createId }))
    if (!result.ok) {
      toast.error("Couldn't save the session", { description: describeWriteError(result.error) })
      desktopImports.answer(request.requestId, { status: "failed", added: 0, duplicates: 0, failed: request.received })
      return true
    }
    const saved = result.value
    toast.success(`Saved “${saved.name}”`, { description: `${saved.tabs.length} ${saved.tabs.length === 1 ? "tab" : "tabs"}` })
    desktopImports.answer(request.requestId, { status: "done", project: `session “${saved.name}”`, added: saved.tabs.length, duplicates: 0, failed: request.rejected })
    openSessions()
    return true
  }

  /** One conversation from Chrome: saved (useDesktopImport answers the bridge), then shown where it went. */
  function saveDesktopConversation(request: DesktopConversationRequest, workspaceId: string): Promise<boolean> {
    return desktopImports.saveCapture(request, workspaceId, workspaceNamed(workspaceId)).then((saved) => {
      if (saved.ok) showDesktopImportProject(workspaceId)
      // A project that vanished meanwhile: the dialog asks again.
      return saved.ok || saved.reason !== "project-missing"
    })
  }

  /** Land on the project a desktop import went to, so what arrived is seen arriving. */
  function showDesktopImportProject(workspaceId: string) {
    const after = storeRef.current
    if (after && after.currentId !== workspaceId) {
      persist(switchWorkspace(after, workspaceId))
      recordWorkspaceVisit()
    }
    setView("workspace")
  }

  function workspaceTabById(workspaceId: string, tabId: string | undefined): Tab | undefined {
    if (!tabId) return undefined
    return storeRef.current?.workspaces.find((workspace) => workspace.id === workspaceId)?.tabs.find((tab) => tab.id === tabId)
  }

  function notifySourcesAdded(workspaceId: string, name: string, plan: IngestionPlan, counts: ReturnType<typeof describeIngestion>) {
    const extra = [
      ...(counts.duplicates > 0 ? [`${counts.duplicates} already in ${name}`] : []),
      ...(counts.invalid > 0 ? [`${counts.invalid} couldn't be added`] : []),
    ].join(" · ")
    if (counts.added > 0) {
      // One source: say which, so a drop or quick add lands visibly ("Added to History IA · Britannica — Cuban missile crisis").
      const single = counts.added === 1 ? plan.added[0] ?? workspaceTabById(workspaceId, plan.adopted[0]) : undefined
      toast.success(counts.added === 1 ? `Added to ${name}` : `Added ${counts.added} resources to ${name}`, {
        description: extra || (single ? `${single.title?.trim() || single.domain} · Hubble is reading it now.` : "Hubble is reading them now."),
        action: { label: "Undo", onClick: () => undoSourcesAdded(workspaceId, plan) },
      })
      return
    }
    if (counts.duplicates > 0 && counts.invalid === 0) {
      const duplicate = plan.outcomes.find((outcome) => outcome.status === "duplicate")
      toast.info(`Already in ${name}`, {
        description: counts.duplicates === 1 ? "It's already in this project." : `These ${counts.duplicates} are already in this project.`,
        ...(duplicate ? { action: { label: "Open", onClick: () => openTab(duplicate.input.url) } } : {}),
      })
      return
    }
    const invalid = plan.outcomes.find((outcome) => outcome.status === "invalid")
    toast.error(counts.invalid === 1 ? "That item couldn't be added." : `${counts.invalid} items couldn't be added.`, {
      description:
        invalid?.status === "invalid" && invalid.reason === "conversation-link"
          ? `${CONVERSATION_LINK_WORDS}.`
          : invalid?.status === "invalid" && invalid.reason === "unsupported-scheme"
            ? "Only web pages, PDFs and videos with a web address can be added."
            : "Drop links, tabs or the address bar from Chrome, or paste web addresses.",
    })
  }

  /** Exactly what one add did, undone: new sources removed, adopted tabs back to plain tabs. */
  function undoSourcesAdded(workspaceId: string, plan: IngestionPlan) {
    const latest = storeRef.current
    const workspace = latest?.workspaces.find((entry) => entry.id === workspaceId)
    if (!latest || !workspace) return
    const added = new Set(plan.added.map((tab) => tab.id))
    const adopted = new Set(plan.adopted)
    const tabs = workspace.tabs
      .filter((tab) => !added.has(tab.id))
      .map((tab) => {
        if (!adopted.has(tab.id)) return tab
        const plain = { ...tab }
        delete plain.resource
        return plain
      })
    persist(updateWorkspaceTabs(latest, workspaceId, tabs))
    resources.forget(workspaceId, [...added, ...adopted])
    recordProjectEvent({ workspaceId, kind: "sources_removed", count: added.size + adopted.size })
  }

  /** Removes sources from a project. The page or file itself is untouched: only Hubble's reference goes. */
  function handleRemoveSources(workspaceId: string, tabIds: string[]) {
    const before = storeRef.current
    const workspace = before?.workspaces.find((entry) => entry.id === workspaceId)
    if (!before || !workspace) return
    const ids = new Set(tabIds)
    const removed = workspace.tabs.filter((tab) => ids.has(tab.id))
    if (removed.length === 0) return
    persist(updateWorkspaceTabs(before, workspaceId, workspace.tabs.filter((tab) => !ids.has(tab.id))))
    recordProjectEvent({ workspaceId, kind: "sources_removed", count: removed.length })
    let undone = false
    const forgetUnlessUndone = () => {
      if (!undone) resources.forget(workspaceId, tabIds)
    }
    toast(`Removed ${removed.length === 1 ? (removed[0]!.title?.trim() || removed[0]!.domain) : `${removed.length} resources`} from ${subjectName(workspace)}`, {
      description: "The original page is untouched.",
      action: {
        label: "Undo",
        onClick: () => {
          const latest = storeRef.current
          const target = latest?.workspaces.find((entry) => entry.id === workspaceId)
          if (!latest || !target) return
          undone = true
          const present = new Set(target.tabs.map((tab) => tab.id))
          persist(updateWorkspaceTabs(latest, workspaceId, [...target.tabs, ...removed.filter((tab) => !present.has(tab.id))]))
        },
      },
      onAutoClose: forgetUnlessUndone,
      onDismiss: forgetUnlessUndone,
    })
  }

  function handleRenameSource(workspaceId: string, tabId: string, title: string) {
    const latest = storeRef.current
    const workspace = latest?.workspaces.find((entry) => entry.id === workspaceId)
    if (!latest || !workspace) return
    persist(updateWorkspaceTabs(latest, workspaceId, workspace.tabs.map((tab) => (tab.id === tabId ? { ...tab, title } : tab))))
  }

  /** `at`: an address Hubble built for this resource (a video at a moment) — opened instead of the saved one. */
  function handleOpenSource(workspaceId: string, tabId: string, at?: string) {
    const latest = storeRef.current
    const workspace = latest?.workspaces.find((entry) => entry.id === workspaceId)
    const tab = workspace?.tabs.find((entry) => entry.id === tabId)
    if (!latest || !workspace || !tab) return
    openTab(at && sameResource(at, tab.url) ? at : tab.url)
    commitStore(updateWorkspaceTabs(latest, workspaceId, workspace.tabs.map((entry) => (entry.id === tabId ? { ...entry, lastAccessedAt: Date.now() } : entry))))
  }

  function projectHomeFor(workspace: NonNullable<typeof currentWorkspace>, emptyExtra?: React.ReactNode) {
    const noteActions: NoteActions = {
      update: (noteId, patch) => handleUpdateNote(workspace.id, noteId, patch),
      saveText: (noteId, text) => handleSaveNoteText(workspace.id, noteId, text),
      remove: (noteIds) => handleRemoveNotes(workspace.id, noteIds),
    }
    const focus = focusItem?.workspaceId === workspace.id ? focusItem : null
    return (
      <ProjectHome
        key={workspace.id}
        workspace={workspace}
        now={now}
        onAddSources={(inputs, origin) => handleAddSources(workspace.id, inputs, origin)}
        resources={sourceActions}
        notes={noteActions}
        files={{
          upload: (files, onOutcome) => fileUploads.upload(workspace.id, files, onOutcome),
          retry: (noteId) => fileUploads.retry(workspace.id, noteId),
          download: (noteId) => void handleDownloadFile(workspace.id, noteId),
        }}
        onRenameSource={(tabId, title) => handleRenameSource(workspace.id, tabId, title)}
        onRemoveSources={(tabIds) => handleRemoveSources(workspace.id, tabIds)}
        onOpenSource={(tab) => handleOpenSource(workspace.id, tab.id)}
        onOpenSourceAt={(tab, url) => handleOpenSource(workspace.id, tab.id, url)}
        onUpdateBrief={(brief) => handleUpdateWorkspaceBrief(workspace.id, brief)}
        onCapture={(mode) => openCapture(workspace.id, mode)}
        onRename={(name) => handleRenameWorkspace(workspace.id, name)}
        allWorkspaces={store?.workspaces ?? NO_WORKSPACES}
        onOpenProject={openSubject}
        onShowInGraph={showInGraph}
        showSessions
        {...(focus ? { focusItem: { ref: focus.ref, nonce: focus.nonce, ...(focus.turn !== undefined ? { turn: focus.turn } : {}), ...(focus.terms ? { terms: focus.terms } : {}) } } : {})}
        {...(quickAdd ? { quickAdd } : {})}
        {...(emptyExtra ? { emptyExtra } : {})}
      />
    )
  }

  /*
    Knowledge without an address, and AI conversations.

    Every conversation — saved from a page by Hubble for Chrome, imported
    from an export file, or pasted — goes through planConversationSave and
    applyConversationSave (lib/conversations/save.ts): the same duplicate rule
    (same address and text: unchanged; same address, new text: updated in
    place), the same provenance. Content is written to the content store
    first and the project changes only for what was kept, so a project never
    claims text it does not hold.
  */
  async function saveConversations(workspaceId: string, inputs: readonly ConversationInput[]): Promise<ConversationSaveSummary & { titles: string[] }> {
    const summary = { added: 0, updated: 0, unchanged: 0, kept: 0, failed: 0, titles: [] as string[] }
    let working = storeRef.current
    if (!working || !working.workspaces.some((workspace) => workspace.id === workspaceId)) return { ...summary, failed: inputs.length }
    // Planned one after another against a working copy, so the same conversation twice in one file is one item.
    const plans: ConversationSave[] = []
    for (const input of inputs) {
      const plan = planConversationSave(working, workspaceId, input, createTimestamp(), createId)
      if (!plan) {
        summary.failed += 1
        continue
      }
      if (plan.outcome === "unchanged" || plan.outcome === "kept") {
        if (plan.outcome === "kept") summary.kept += 1
        else summary.unchanged += 1
        summary.titles.push(plan.target === "note" ? plan.note.title : (plan.tab.title ?? input.title))
        continue
      }
      plans.push(plan)
      working = applyConversationSave(working, plan, createTimestamp())
    }
    // Text first; only what was kept is applied to the project.
    const kept: ConversationSave[] = []
    for (let index = 0; index < plans.length; index += 50) {
      const batch = plans.slice(index, index + 50)
      const results = await Promise.all(batch.map((plan) => putContent(workspaceId, plan.id, plan.content).then(() => true, () => false)))
      batch.forEach((plan, offset) => (results[offset] ? kept.push(plan) : (summary.failed += 1)))
    }
    if (kept.length > 0) {
      let latest = storeRef.current
      if (!latest || !latest.workspaces.some((workspace) => workspace.id === workspaceId)) return { ...summary, failed: summary.failed + kept.length }
      const at = createTimestamp()
      // A conversation another save added while this one wrote its text is left as that save made it: one copy, never two.
      const applied: ConversationSave[] = []
      for (const plan of kept) {
        const next = applyConversationSave(latest, plan, at)
        if (next === latest) {
          summary.unchanged += 1
          summary.titles.push(plan.target === "note" ? plan.note.title : (plan.tab.title ?? ""))
          continue
        }
        latest = next
        applied.push(plan)
      }
      if (applied.length > 0) {
        const beforeSave = storeRef.current
        persist(latest)
        // Not on disk: undone in memory too, so neither this page nor the extension ever calls it saved.
        if (!lastCommitPersistedRef.current) {
          if (beforeSave) commitStore(beforeSave)
          return { ...summary, failed: summary.failed + applied.length }
        }
      }
      for (const plan of applied) {
        if (plan.outcome === "added") summary.added += 1
        else summary.updated += 1
        summary.titles.push(plan.target === "note" ? plan.note.title : (plan.tab.title ?? ""))
      }
      const provider = inputs[0]?.provider
      const method = inputs[0]?.method
      if (summary.added > 0) {
        recordProjectEvent({ workspaceId, kind: "conversation_saved", count: summary.added, ...(provider ? { provider } : {}) })
        recordLoopMilestone(method === "export" ? "conversation_imported" : "conversation_captured", provider ? { provider } : {})
      }
      if (summary.updated > 0) recordProjectEvent({ workspaceId, kind: "conversation_updated", count: summary.updated, ...(provider ? { provider } : {}) })
    }
    return summary
  }

  /** One conversation from Hubble for Chrome: saved, said where it went, and answered to the extension. */
  async function saveCapturedConversation(workspaceId: string, input: ConversationInput, truncated: boolean): Promise<CaptureSaveResult> {
    if (!storeRef.current?.workspaces.some((workspace) => workspace.id === workspaceId)) return { ok: false, reason: "project-missing" }
    const summary = await saveConversations(workspaceId, [input])
    if (summary.failed > 0) {
      toast.error("A conversation from Chrome couldn't be saved", { description: "Hubble couldn't keep its text on this device. Nothing was changed — try again." })
      return { ok: false, reason: "storage-failed" }
    }
    const name = workspaceNamed(workspaceId)
    const outcome = summary.added > 0 ? "added" : summary.updated > 0 ? "updated" : summary.kept > 0 ? "kept" : "unchanged"
    const title = summary.titles[0] ?? input.title
    const words =
      outcome === "added" ? `Saved to ${name}` : outcome === "updated" ? `Updated in ${name}` : outcome === "kept" ? `Kept the longer saved copy in ${name}` : `Already in ${name}, unchanged`
    toast.success(words, { description: `${title}${truncated ? " · very long, so only the first part was kept" : ""}` })
    return { ok: true, outcome, title }
  }

  async function handleSaveNote(workspaceId: string, draft: NoteDraft): Promise<NoteSaveResult> {
    const latest = storeRef.current
    const workspace = latest?.workspaces.find((entry) => entry.id === workspaceId)
    if (!latest || !workspace) return { ok: false, message: "That project is gone." }
    if ((workspace.notes?.length ?? 0) >= NOTE_LIMITS.notesPerProject) return { ok: false, message: "This project has as many notes as it can hold. Remove some first." }
    const composed = composeNote(workspace, draft, createTimestamp(), createId)
    if (!composed.ok) return { ok: false, message: composed.reason === "too-long" ? "That's too long to keep as one note. Split it into parts." : "There's nothing to save." }
    if (composed.duplicate) return { ok: true, duplicate: true }
    try {
      await putContent(workspaceId, composed.note.id, composed.content)
    } catch {
      return { ok: false, message: "Hubble couldn't keep that on this device, so nothing was saved. Try again." }
    }
    const after = storeRef.current
    if (!after) return { ok: false, message: "Hubble isn't ready. Try again." }
    persist(addProjectNote(after, workspaceId, composed.note, createTimestamp()))
    recordProjectEvent({ workspaceId, kind: "note_added", ...(composed.note.provider ? { provider: composed.note.provider } : {}) })
    recordLoopMilestone("note_added")
    return { ok: true, duplicate: false }
  }

  function handleUpdateNote(workspaceId: string, noteId: string, patch: { title?: string; tags?: string[] }) {
    const latest = storeRef.current
    if (!latest) return
    const next = updateProjectNote(latest, workspaceId, noteId, patch, createTimestamp())
    if (next !== latest) persist(next)
  }

  async function handleSaveNoteText(workspaceId: string, noteId: string, text: string): Promise<boolean> {
    const body = cleanBody(text, NOTE_LIMITS.bodyChars)
    if (!body) return false
    try {
      await putContent(workspaceId, noteId, { kind: "note", text: body, extractedAt: createTimestamp() })
    } catch {
      return false
    }
    const latest = storeRef.current
    if (!latest) return false
    persist(updateProjectNote(latest, workspaceId, noteId, { contentHash: contentHash({ text: body }), chars: body.length }, createTimestamp()))
    return true
  }

  /** An uploaded file's original, saved back out. Says so only when it can't be — a cancelled Save dialog is not a failure. */
  async function handleDownloadFile(workspaceId: string, noteId: string) {
    const result = await fileUploads.download(workspaceId, noteId)
    if (result === "missing") toast.error("The original file isn't on this device any more", { description: "Its text is still here. Upload the file again to keep a copy." })
    else if (result === "not-saved" && !isDesktopShell) toast.error("The file couldn't be saved. Try again.")
  }

  /** Removes notes (and uploaded files); their text and originals are forgotten once the toast closes without Undo — the same rule as a source's. */
  function handleRemoveNotes(workspaceId: string, noteIds: string[]) {
    const before = storeRef.current
    const workspace = before?.workspaces.find((entry) => entry.id === workspaceId)
    if (!before || !workspace) return
    const ids = new Set(noteIds)
    const removed = (workspace.notes ?? []).filter((note) => ids.has(note.id))
    if (removed.length === 0) return
    persist(removeProjectNotes(before, workspaceId, noteIds, createTimestamp()))
    recordProjectEvent({ workspaceId, kind: "sources_removed", count: removed.length })
    let undone = false
    const forgetUnlessUndone = () => {
      if (!undone) void deleteContent(workspaceId, noteIds).catch(() => undefined)
    }
    const onlyFiles = removed.every((note) => note.kind === "file")
    toast(`Removed ${removed.length === 1 ? removed[0]!.title : plural(removed.length, onlyFiles ? "file" : "note", onlyFiles ? "files" : "notes")} from ${subjectName(workspace)}`, {
      ...(onlyFiles ? { description: "The file on your device is untouched." } : {}),
      action: {
        label: "Undo",
        onClick: () => {
          let latest = storeRef.current
          if (!latest) return
          undone = true
          for (const note of removed) latest = addProjectNote(latest, workspaceId, note, createTimestamp())
          persist(latest)
        },
      },
      onAutoClose: forgetUnlessUndone,
      onDismiss: forgetUnlessUndone,
    })
  }

  function openCapture(workspaceId: string, mode: CaptureMode) {
    setCapture({ workspaceId, mode, nonce: Date.now() })
  }

  /** "Use in AI chat" from anywhere: the chosen things, as items of one project. Collections become their saved tabs. */
  function openReuse(selection: MemorySelection) {
    const workspace = storeRef.current?.workspaces.find((entry) => entry.id === selection.workspaceId)
    if (!workspace) return
    const refs: KnowledgeItemRef[] = [...(selection.refs ?? [])]
    const tabIds = new Set(selection.tabIds ?? [])
    if (selection.collectionIds && selection.collectionIds.length > 0) {
      const wanted = new Set(selection.collectionIds)
      for (const collection of loadCollectionState().collections) {
        if (collection.workspaceId === workspace.id && wanted.has(collection.id)) collection.tabIds.forEach((id) => tabIds.add(id))
      }
    }
    for (const tab of workspace.tabs) if (tabIds.has(tab.id)) refs.push({ kind: "source", tabId: tab.id })
    setReuse({ workspaceId: workspace.id, refs, nonce: Date.now(), ...(selection.provider ? { provider: selection.provider } : {}) })
  }

  /** Opens an item where it lives: its project, its reader — or, for a saved tab Hubble holds no text for, the page itself. */
  function openItem(workspaceId: string, ref: KnowledgeItemRef, turn?: number, terms?: readonly string[]) {
    const latest = storeRef.current
    const workspace = latest?.workspaces.find((entry) => entry.id === workspaceId)
    if (!latest || !workspace) return
    if (ref.kind === "source") {
      const tab = workspace.tabs.find((entry) => entry.id === ref.tabId)
      if (!tab) return
      if (!tab.resource) {
        handleOpenSource(workspaceId, tab.id)
        return
      }
    }
    if (latest.currentId !== workspaceId) handleSwitchWorkspace(workspaceId)
    setFocusItem({ workspaceId, ref, nonce: Date.now(), ...(turn !== undefined ? { turn } : {}), ...(terms ? { terms } : {}) })
    setView("workspace")
  }

  function openSessions(options?: { save?: boolean }) {
    setSessionsStart({ save: options?.save === true, nonce: Date.now() })
    setView("sessions")
  }

  function openSearch(query = "", workspaceId?: string) {
    setSearchStart({ query, nonce: Date.now(), ...(workspaceId ? { workspaceId } : {}) })
    setView("search")
  }

  function handleClear() {
    if (!store) return
    undoSnapshotRef.current = null
    persist(updateWorkspaceTabs(store, getCurrentWorkspace(store).id, []))
  }

  function handleSwitchWorkspace(id: string) {
    if (!store) return
    undoSnapshotRef.current = null
    persist(switchWorkspace(store, id))
    if (id !== store.currentId) recordWorkspaceVisit()
  }

  /** Opens a project's page — the rail's rows, Home's cards. */
  function openSubject(id: string) {
    // Already the current one: nothing to switch, nothing to write.
    if (store && id !== store.currentId) handleSwitchWorkspace(id)
    setView("workspace")
  }

  /** New project: created, given its brief if one was written, and opened — no further setup. */
  function handleCreateWorkspace(name: string, brief?: NewProjectBrief) {
    if (!store) return
    undoSnapshotRef.current = null
    let next = createSubjectIn(store, name, subjectsStarted)
    const id = next.currentId
    markSubjectsStarted()
    setSubjectsStarted(true)
    if (brief) next = setWorkspaceBrief(next, id, brief)
    persist(next)
    recordLoopMilestone("workspace_created")
    recordLoopMilestone("project_created")
    recordProjectEvent({ workspaceId: id, kind: "project_created" })
    setView("workspace")
  }

  function handleRenameWorkspace(id: string, name: string) {
    if (!store) return
    persist(renameWorkspace(store, id, name))
  }

  function handleUpdateWorkspaceLogo(id: string, logo: string | undefined) {
    if (!store) return
    persist(updateWorkspaceLogo(store, id, logo))
  }

  function handleUpdateWorkspaceBrief(id: string, brief: { description: string; focus: string }) {
    if (!store) return
    const next = setWorkspaceBrief(store, id, brief)
    if (next !== store) persist(next)
  }

  function handleDeleteWorkspace(id: string) {
    if (!store) return
    undoSnapshotRef.current = null
    persist(deleteWorkspace(store, id))
    // Its history and everything stored for its items (read text, conversations, notes) go with it.
    forgetProjectActivity(id)
    void pruneProjectContent(id, new Set()).catch(() => undefined)
  }

  function handleImportJson(text: string) {
    const result = parseWorkspaceExport(text)
    if (!result.ok) {
      toast.error("Couldn't import workspace", {
        description: IMPORT_FAILURE_MESSAGES[result.reason],
      })
      return
    }
    if (result.workspaces.length === 0) {
      toast.error("Couldn't import workspace", { description: "No workspaces found in that file." })
      return
    }
    if (!store) return

    const withImported = addWorkspaces(store, result.workspaces)
    persist(switchWorkspace(withImported, result.workspaces[0].id))
    // Saved text that came with the file (an "Export everything"), under the ids its items have now.
    if (result.contents.length > 0) {
      void Promise.all(result.contents.map((entry) => putContent(entry.workspaceId, entry.itemId, entry.content).then(() => true, () => false))).then((saved) => {
        const failed = saved.filter((ok) => !ok).length
        if (failed > 0) toast.warning(`${plural(failed, "item's", "items'")} saved text couldn't be kept on this device`, { description: "Their titles and links were imported." })
      })
    }

    // Dependencies live in their own localStorage-backed store (see
    // hooks/use-dependency-store.ts), not inside WorkspaceStore itself, so
    // they're merged directly into that persisted state here rather than
    // through `store`. Switching `currentId` above changes the key on
    // <WorkspaceView key={currentWorkspace.id}>, which remounts it and
    // makes it re-read this merge from localStorage on mount.
    if (result.dependencies.length > 0) {
      const validIds = new Set(withImported.workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
      const merged = mergeDependencies(loadDependencyState().dependencies, result.dependencies);
      saveDependencyState(pruneDependencyState({ version: 1, dependencies: merged }, validIds));
    }

    // Collections live in their own localStorage-backed store (see
    // hooks/use-collection-store.ts) — same "merge directly into persisted
    // state, not through `store`" reasoning as dependencies above. Imported
    // collections always carry freshly-minted ids (see
    // json-import.ts's sanitizeCollections), so a plain concat can't collide
    // with anything already in the store.
    if (result.collections.length > 0) {
      const validWorkspaceIds = new Set(withImported.workspaces.map((w) => w.id));
      const tabWorkspaceOf = new Map<string, string>();
      for (const w of withImported.workspaces) for (const t of w.tabs) tabWorkspaceOf.set(t.id, w.id);
      const merged = [...loadCollectionState().collections, ...result.collections];
      saveCollectionState(pruneCollectionState({ version: 1, collections: merged }, validWorkspaceIds, tabWorkspaceOf));
    }

    const skippedNote =
      result.skippedWorkspaces > 0 || result.skippedTabs > 0 || result.skippedDependencies > 0 || result.skippedCollections > 0
        ? ` (skipped ${result.skippedWorkspaces} workspace${result.skippedWorkspaces === 1 ? "" : "s"}, ${result.skippedTabs} tab${result.skippedTabs === 1 ? "" : "s"}${result.skippedDependencies > 0 ? `, ${result.skippedDependencies} dependenc${result.skippedDependencies === 1 ? "y" : "ies"}` : ""}${result.skippedCollections > 0 ? `, ${result.skippedCollections} collection${result.skippedCollections === 1 ? "" : "s"}` : ""})`
        : ""
    toast.success(
      `Imported ${result.workspaces.length} project${result.workspaces.length === 1 ? "" : "s"}${skippedNote}`
    )
  }

  /**
   * What the Graph can do to a saved tab. Each is the same write the project
   * view makes, against the latest committed store, so a change made in the
   * Graph is indistinguishable from one made there.
   */
  const graphTabActions: KnowledgeGraphTabActions = {
    open: (workspaceId, tabId, options) => {
      const latest = storeRef.current
      const workspace = latest?.workspaces.find((entry) => entry.id === workspaceId)
      const tab = workspace?.tabs.find((entry) => entry.id === tabId)
      if (!latest || !workspace || !tab) return
      void openTab(tab.url, options)
      // Opened from Hubble: it belongs in Recents, as an open from the project view does.
      commitStore(updateWorkspaceTabs(latest, workspaceId, workspace.tabs.map((entry) => (entry.id === tabId ? { ...entry, lastAccessedAt: Date.now() } : entry))))
    },
    update: (workspaceId, tabId, patch) => {
      const latest = storeRef.current
      const workspace = latest?.workspaces.find((entry) => entry.id === workspaceId)
      if (!latest || !workspace) return
      persist(updateWorkspaceTabs(latest, workspaceId, workspace.tabs.map((entry) => (entry.id === tabId ? { ...entry, ...patch } : entry))))
    },
    move: (workspaceId, tabIds, targetWorkspaceId) => {
      const latest = storeRef.current
      if (!latest) return
      const result = moveTabsBetweenWorkspaces(latest, tabIds, targetWorkspaceId, workspaceId)
      if (result.moved.length === 0) return
      persist(result.store)
      const target = result.store.workspaces.find((entry) => entry.id === targetWorkspaceId)
      toast.success(`Moved to ${target ? subjectName(target) : "project"}`)
    },
    remove: handleRemoveSources,
  }

  /** The Graph: every project, everything in them — saved tabs included — and what connects them. Never gated: it draws from saved records, not from the tab organizer. */
  function handleOpenGraph() {
    setGraphFocus(undefined)
    setView("graph")
  }

  /** Opens the Graph with one thing selected: a project (p:<id>) or an item. */
  function showInGraph(nodeId: string) {
    setGraphFocus({ nodeId, nonce: Date.now() })
    setView("graph")
  }

  /*
    Smart Organize, open tabs: the confirmed proposal goes through the same
    source pipeline as every other add (applySmartToSubjects → ingestResources),
    against the live store, in one commit. Undo takes back exactly what this
    added — never anything done since — and new subjects only while still empty.
  */
  function handleApplySmartOpenTabs(proposal: SmartProposal) {
    const before = storeRef.current
    if (!before) return
    let applied: ReturnType<typeof applySmartToSubjects>
    try {
      applied = applySmartToSubjects(before, proposal, { now: createTimestamp(), subjectsStarted, origin: "extension" })
    } catch {
      toast.error("Couldn't organize these tabs", { description: "Nothing was changed. Try again." })
      return
    }
    setOrganizeOpenTabs(false)
    const { title, details } = describeApplied(applied.results, "open-tabs")
    if (!applied.changed) {
      toast(title, details.length > 0 ? { description: details.join(" · ") } : undefined)
      return
    }
    persist(applied.store)
    const { receipt } = applied
    if (receipt.createdSubjects.length > 0 || receipt.renamedDefault) {
      markSubjectsStarted()
      setSubjectsStarted(true)
      recordLoopMilestone("project_created")
      for (const workspaceId of [...receipt.createdSubjects.map((created) => created.workspaceId), ...(receipt.renamedDefault ? [receipt.renamedDefault.workspaceId] : [])]) {
        recordProjectEvent({ workspaceId, kind: "project_created" })
      }
    }
    for (const result of applied.results) {
      if (result.targetId && result.added > 0) recordProjectEvent({ workspaceId: result.targetId, kind: "sources_added", count: result.added, origin: "extension" })
    }
    if (applied.results.some((result) => result.added > 0)) recordLoopMilestone("resource_added")
    let undone = false
    const notify = applied.results.some((result) => result.error) ? toast.warning : toast
    notify(title, {
      ...(details.length > 0 ? { description: details.join(" · ") } : {}),
      action: {
        label: "Undo",
        onClick: () => {
          const latest = storeRef.current
          if (undone || !latest) return
          undone = true
          // Tabs the person has made theirs in ways the tab record cannot show: filed in a collection, given content.
          const filed = loadCollectionState().collections.flatMap((collection) => collection.tabIds)
          const reverted = undoSmartToSubjects(latest, receipt, { protect: new Set([...filed, ...suppliedContentRef.current]) })
          if (!reverted.changed) {
            toast("Nothing left to undo", { description: "Everything it added has been changed or removed since." })
            return
          }
          persist(reverted.store)
          // Only the tabs actually taken back: a kept one's stored content is still its own.
          for (const entry of reverted.removedTabs) {
            resources.forget(entry.workspaceId, entry.tabIds)
            recordProjectEvent({ workspaceId: entry.workspaceId, kind: "sources_removed", count: entry.tabIds.length })
          }
          const kept = [
            ...(reverted.keptSubjects.length > 0 ? [`kept ${reverted.keptSubjects.join(", ")}`] : []),
            ...(reverted.keptTabs > 0 ? [`kept ${reverted.keptTabs} you've changed since`] : []),
          ]
          if (kept.length > 0) toast("Undid the organization", { description: `Mostly — ${kept.join("; ")}.` })
        },
      },
    })
  }

  /*
    Context intelligence: a confirmed suggestion. Its pages go through the
    same apply as Smart Organize's open tabs (applySmartToSubjects →
    ingestResources), against the live store, in one commit; the person's
    decision is recorded only once that commit is made. A conversation whose
    tab is open and readable has its text saved by the ordinary Save to
    Hubble job; any other is saved as a link that says its text is missing.
    Undo takes back exactly what this added, like Smart Organize's.
  */
  async function handleAcceptSuggestion(suggestion: Suggestion, edits: SuggestionEdits): Promise<boolean> {
    const before = storeRef.current
    const context = getContextSnapshot()
    const proposal = proposalFromSuggestion(suggestion, context.records, edits)
    if (!before || !proposal) {
      toast.error("Couldn't save these", { description: "The pages are no longer in Hubble's activity. Nothing was changed." })
      return false
    }
    let applied: ReturnType<typeof applySmartToSubjects>
    try {
      applied = applySmartToSubjects(before, proposal, { now: createTimestamp(), subjectsStarted, origin: "extension" })
    } catch {
      toast.error("Couldn't save these", { description: "Nothing was changed. Try again." })
      return false
    }
    const result = applied.results[0]
    if (!result?.targetId) {
      toast.error("Couldn't save these", { description: result?.error === "destination-missing" ? "That project was deleted. Choose another in Review." : "Nothing was changed." })
      return false
    }
    const workspaceId = result.targetId
    if (applied.changed) persist(applied.store)
    if (applied.changed && !lastCommitPersistedRef.current) {
      toast.error("Couldn't save these", { description: "Your browser's storage is full or unavailable." })
      return false
    }
    const decided = writeContext((state) => acceptSuggestion(state, suggestion.id, { recordKeys: edits.recordKeys, workspaceId, now: Date.now() }))
    const { receipt } = applied
    if (receipt.createdSubjects.length > 0 || receipt.renamedDefault) {
      markSubjectsStarted()
      setSubjectsStarted(true)
      recordLoopMilestone("project_created")
      recordProjectEvent({ workspaceId, kind: "project_created" })
    }
    if (result.added > 0) {
      recordProjectEvent({ workspaceId, kind: "sources_added", count: result.added, origin: "extension" })
      recordLoopMilestone("resource_added")
    }

    // Conversations: the text comes from the open page, through Save to Hubble's own job.
    const byKey = new Map(context.records.map((record) => [record.key, record]))
    const conversations = edits.recordKeys.map((key) => byKey.get(key)).filter((record) => record?.kind === "conversation")
    let textSaved = 0
    let textQueued = 0
    let linkOnly = 0
    for (const record of conversations) {
      if (!record || !willSaveText(record)) {
        linkOnly += 1
        continue
      }
      const answer = await captureConversation(record.url, workspaceId)
      // "Saved" only on the page's answer that it is on disk; a queued job is said to be on its way, not done.
      if (answer.ok && answer.value.status === "saved") textSaved += 1
      else if (answer.ok && answer.value.status === "queued") textQueued += 1
      else linkOnly += 1
    }

    const name = result.targetName ?? "the project"
    const details = [
      result.alreadyThere > 0 ? `${result.alreadyThere} already there` : "",
      textSaved > 0 ? `${textSaved === 1 ? "a conversation's" : `${textSaved} conversations'`} text saved` : "",
      textQueued > 0 ? `${textQueued === 1 ? "a conversation's text is" : `${textQueued} conversations' text is`} still being saved by Hubble for Chrome` : "",
      linkOnly > 0 ? `${linkOnly === 1 ? "1 conversation" : `${linkOnly} conversations`} saved as a link — open it and use Save to Hubble for the text` : "",
      decided.ok ? "" : "Hubble couldn't record the decision, so it may suggest these again",
    ].filter(Boolean)
    let undone = false
    toast(result.added > 0 ? `Saved ${result.added} to ${name}` : `Already in ${name}`, {
      ...(details.length > 0 ? { description: details.join(" · ") } : {}),
      ...(applied.changed
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                const latest = storeRef.current
                if (undone || !latest) return
                undone = true
                const filed = loadCollectionState().collections.flatMap((collection) => collection.tabIds)
                const reverted = undoSmartToSubjects(latest, receipt, { protect: new Set([...filed, ...suppliedContentRef.current]) })
                writeContext((state) => undoAcceptance(state, suggestion.id, Date.now()))
                if (!reverted.changed) {
                  toast("Nothing left to undo", { description: "Everything it added has been changed or removed since." })
                  return
                }
                persist(reverted.store)
                for (const entry of reverted.removedTabs) {
                  resources.forget(entry.workspaceId, entry.tabIds)
                  recordProjectEvent({ workspaceId: entry.workspaceId, kind: "sources_removed", count: entry.tabIds.length })
                }
              },
            },
          }
        : {}),
    })
    return true
  }

  if (!hydrated || !store || !currentWorkspace) return null

  // Chrome → Hubble Desktop: the project choice for a batch the extension sent (see useDesktopImport above).
  const desktopImportDialog = desktopImports.current ? (
    <DesktopImportDialog
      key={desktopImports.current.requestId}
      request={desktopImports.current}
      projects={visibleSubjects(store, subjectsStarted).map((workspace) => ({ id: workspace.id, name: subjectName(workspace) }))}
      currentProjectId={store.currentId}
      onAdd={handleDesktopImport}
      onCancel={(request) => desktopImports.answer(request.requestId, { status: "cancelled", added: 0, duplicates: 0, failed: 0 })}
    />
  ) : null

  // A first-time visitor gets Hubble's public landing page, full-bleed: no
  // sidebar, no content-width clamp, none of the workspace chrome that means
  // nothing to someone who has not dumped anything yet.
  //
  // The condition is deliberately conservative on both halves — the onboarding
  // flag AND an entirely empty store — so a returning user who merely cleared a
  // workspace is never sent back to marketing; they fall through to
  // the project's own empty state below (Hubble 2.0), which still offers the
  // paste-your-tabs field the old in-shell landing had.
  //
  // AppShell stays mounted around this, so an extension dump arriving mid-scroll
  // still lands in the store and the next render swaps straight through to the
  // real app without the landing page having to know it happened.
  //
  // Web only: Hubble Desktop has already been installed — its first screen is
  // Home's "Welcome to Hubble", never a pitch for the app it already is.
  if (!onboarded && !isDesktopShell && store.workspaces.every((w) => w.tabs.length === 0)) {
    return (
      <>
        <FirstRunLanding onEnterApp={() => setOnboarded(true)} />
        {/* Tabs sent from Chrome on a first launch still get their choice. */}
        {desktopImportDialog}
      </>
    )
  }

  /*
    Every destination other than the workspace itself, resolved to the
    element that fills the content column.

    These used to be early `return`s from the component, which meant each
    one replaced the entire shell — opening the Graph, Search, History
    or Settings unmounted the sidebar and left a back chevron as the only
    way home. Two things were wrong with that. The current location was
    invisible, which `design-principles.md` › Agency asks us not to do
    ("keep them informed about what's happening"), and the rail's own
    active state had nothing to mark, because the rail was gone. It also
    made every move between destinations a two-step trip through the
    workspace.

    Resolving them to a value instead lets the shell render once, with the
    rail persistent and the active row lit, which is also what the landing
    page does: its nav stays put while the page changes under it.

    `null` means "no destination" — the workspace content renders instead.
  */
  const subjects = visibleSubjects(store, subjectsStarted)
  const destination: React.ReactNode = (() => {
  if (view === "home") {
    return (
      <HomeView
        subjects={subjects}
        // Never onboarded (a first desktop launch): "Welcome to Hubble". Otherwise, "Start with a project".
        firstRun={!onboarded}
        now={now}
        onOpenSubject={openSubject}
        onNewSubject={() => setNewWorkspaceOpen(true)}
        onOrganizeOpenTabs={() => setOrganizeOpenTabs(true)}
        onOpenItem={(workspaceId, ref) => openItem(workspaceId, ref)}
        onOpenSearch={() => openSearch()}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
        onOpenSessions={openSessions}
        onUseInAi={(workspaceId) => openReuse({ workspaceId })}
        onShowInGraph={showInGraph}
        {...(!isDesktopShell ? { context: { connected: browserConnected, onAccept: handleAcceptSuggestion, onOpenSettings: () => openSettings("context") } } : {})}
      />
    )
  }

  if (view === "sessions") {
    return (
      <SessionsView
        key={sessionsStart.nonce}
        projects={subjects.map((workspace) => ({ id: workspace.id, name: subjectName(workspace) }))}
        now={now}
        openSaveOnMount={sessionsStart.save}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
      />
    )
  }

  if (view === "search") {
    return (
      <SearchView
        key={searchStart.nonce}
        workspaces={subjects.length > 0 ? subjects : store.workspaces}
        initialQuery={searchStart.query}
        {...(searchStart.workspaceId ? { initialWorkspaceId: searchStart.workspaceId } : {})}
        onOpenItem={(workspaceId, ref, turn) => {
          recordLoopMilestone("search_used")
          openItem(workspaceId, ref, turn)
        }}
        onOpenUrl={(url) => void openTab(url)}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
      />
    )
  }

  if (view === "graph") {
    return (
      <KnowledgeGraphView
        workspaces={subjects}
        now={now}
        showSessions
        onOpenItem={(workspaceId, ref) => openItem(workspaceId, ref)}
        onOpenProject={openSubject}
        onUseInAi={(workspaceId, refs) => openReuse({ workspaceId, refs })}
        onOpenUrl={(url) => void openTab(url)}
        onOpenSessions={() => openSessions()}
        onNewProject={() => setNewWorkspaceOpen(true)}
        allWorkspaces={store.workspaces}
        tabActions={graphTabActions}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
        {...(graphFocus ? { focus: graphFocus } : {})}
      />
    )
  }

  if (view === "library") {
    return (
      <LibraryView
        workspaces={subjects}
        now={now}
        onOpenItem={(workspaceId, ref) => openItem(workspaceId, ref)}
        onUseInAi={(workspaceId, refs) => openReuse({ workspaceId, refs })}
        onOpenUrl={(url) => void openTab(url)}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
      />
    )
  }

  if (view === "ai") {
    return (
      <AiView
        workspaces={subjects}
        now={now}
        onUseInAi={(workspaceId, refs, provider) => openReuse({ workspaceId, refs, provider })}
        onOpenItem={(workspaceId, ref) => openItem(workspaceId, ref)}
        onOpenUrl={(url) => void openTab(url)}
        onSaveFromAi={() => setSaveFromAiOpen(true)}
        onOpenAiApps={() => openSettings("ai-apps")}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
      />
    )
  }

  if (view === "settings") {
    return (
      <AppearanceSettingsView
        key={settingsSection ?? "default"}
        initialSection={settingsSection}
        onClose={() => setView(settingsReturn)}
        workspaceSettings={{
          workspaces: store.workspaces,
          currentId: store.currentId,
          onSwitch: handleSwitchWorkspace,
          onRename: handleRenameWorkspace,
          onDelete: handleDeleteWorkspace,
          onUpdateLogo: handleUpdateWorkspaceLogo,
          onImportFile: handleImportJson,
        }}
      />
    )
  }

  if (view === "favorites") {
    return (
      <FavoritesView
        tabs={currentWorkspace.tabs}
        onClose={() => setView("workspace")}
        onCategoryChange={handleCategoryChangeInView}
        onToggleFavorite={handleToggleFavoriteInView}
        onOpenTab={handleOpenTabInView}
        onNotesChange={handleNotesChangeInView}
      />
    )
  }

  if (view === "recents") {
    return (
      <RecentsView
        tabs={currentWorkspace.tabs}
        onClose={() => setView("workspace")}
        onCategoryChange={handleCategoryChangeInView}
        onToggleFavorite={handleToggleFavoriteInView}
        onOpenTab={handleOpenTabInView}
        onNotesChange={handleNotesChangeInView}
      />
    )
  }

  if (view === "history-dump") {
    return (
      <HistoryDumpView
        tabs={currentWorkspace.tabs}
        onClose={() => setView("workspace")}
        onDump={handleHistoryDump}
      />
    )
  }

    return null
  })()

  // ⌘K over transcripts: a moment opens the video at the time it is said.
  const momentCommands = (query: string): Command[] => {
    const terms = searchTerms(query)
    return searchMoments(query).flatMap((hit): Command[] => {
      const workspace = store.workspaces.find((entry) => entry.id === hit.workspaceId)
      const tab = workspace?.tabs.find((entry) => entry.id === hit.tabId)
      if (!workspace || !tab) return []
      const at = hit.location.start
      const video = parseYouTubeUrl(tab.url)
      const url = video ? youtubeMomentUrl(video.videoId, at) : tab.url
      const where = [workspace.id === store.currentId ? undefined : subjectName(workspace), at !== undefined ? formatTimestamp(at) : undefined].filter(Boolean).join(" · ")
      return [
        {
          id: `moment-${workspace.id}-${tab.id}-${hit.location.line}`,
          label: tab.title?.trim() || tab.domain,
          hint: `${where ? `${where} · ` : ""}${hit.snippet}`,
          highlight: terms,
          forceMount: true,
          group: "Moments",
          icon: PlayCircle,
          onSelect: () => handleOpenSource(workspace.id, tab.id, url),
        },
      ]
    })
  }

  // ⌘K: "search everything" for what is typed, before the commands that match it.
  const paletteContent = (query: string): Command[] => {
    const typed = query.trim()
    const search: Command[] =
      typed.length > 1
        ? [
            {
              id: "search-knowledge-for",
              label: `Search everything for “${typed}”`,
              hint: "Conversations, notes and saved pages in every project",
              group: "Navigation",
              icon: Search,
              forceMount: true,
              onSelect: () => openSearch(typed),
            },
          ]
        : []
    return [...search, ...momentCommands(query)]
  }

  const globalCommands = paletteOpen
    ? buildGlobalCommands(
        {
          goWorkspace: () => setView("workspace"),
          goHome: () => setView("home"),
          openSearch: (query) => openSearch(query ?? ""),
          openGraph: handleOpenGraph,
          openFavorites: () => setView("favorites"),
          openRecents: () => setView("recents"),
          openHistoryDump: () => setView("history-dump"),
          openSettings: (section) => openSettings(section),
          switchWorkspace: handleSwitchWorkspace,
          newWorkspace: () => setNewWorkspaceOpen(true),
          openUrl: (url) => void openTab(url),
          organizeOpenTabs: () => setOrganizeOpenTabs(true),
          reuseCurrent: () => openReuse({ workspaceId: currentWorkspace.id }),
          capture: (mode) => openCapture(currentWorkspace.id, mode),
          saveFromAi: () => setSaveFromAiOpen(true),
          goAi: () => setView("ai"),
          goLibrary: () => setView("library"),
          goSessions: () => openSessions(),
          ...(appearance ? { setTheme: (id: "midnight" | "hubble-light") => appearance.setThemeId(id) } : {}),
        },
        { workspaces: store.workspaces, currentId: store.currentId, themeId: appearance?.settings?.themeId }
      )
    : []

  // "Add to project" from any tab menu or selection: the same pipeline as a drop.
  const projectActions: ProjectActions = {
    currentId: currentWorkspace.id,
    projects: store.workspaces.map((workspace) => ({ id: workspace.id, name: subjectName(workspace) })),
    addTabs: (tabs, projectId) => {
      handleAddSources(projectId, tabs.map((tab) => ({ url: tab.url, ...(tab.title ? { title: tab.title } : {}), ...(tab.favicon ? { favicon: tab.favicon } : {}) })), "import")
    },
  }

  // "Use in AI chat" everywhere it is offered: one dialog, owned here.
  const memoryActions: MemoryActions = { currentWorkspaceId: currentWorkspace.id, reuse: openReuse }
  const reuseWorkspace = reuse ? store.workspaces.find((workspace) => workspace.id === reuse.workspaceId) : undefined
  const captureWorkspace = capture ? store.workspaces.find((workspace) => workspace.id === capture.workspaceId) : undefined

  return (
    <CommandPaletteHostContext.Provider value={paletteHost}>
    <ProjectActionsProvider value={projectActions}>
    <MemoryActionsProvider value={memoryActions}>
    <div className="flex min-h-screen">
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={paletteOpen ? mergeCommands(globalCommands, contributedCommands) : []}
        placeholder="Search Hubble"
        searchContent={paletteContent}
      />
      {desktopImportDialog}
      <OpenTabsOrganize
        open={organizeOpenTabs}
        onOpenChange={setOrganizeOpenTabs}
        workspaces={store.workspaces}
        subjects={subjects}
        onApply={handleApplySmartOpenTabs}
      />
      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onOpenChange={setNewWorkspaceOpen}
        onCreate={(name, brief) => {
          handleCreateWorkspace(name, brief)
          setNewWorkspaceOpen(false)
          setView("workspace")
        }}
      />
      {reuse && reuseWorkspace && (
        <ReuseDialog
          key={reuse.nonce}
          open
          onOpenChange={(open) => !open && setReuse(null)}
          workspace={reuseWorkspace}
          initialRefs={reuse.refs}
          onCopied={({ items }) => {
            recordLoopMilestone("memory_copied")
            recordProjectEvent({ workspaceId: reuseWorkspace.id, kind: "memory_reused", count: items })
          }}
          onTransferred={({ items, provider }) => {
            recordLoopMilestone("memory_inserted", { provider })
            recordProjectEvent({ workspaceId: reuseWorkspace.id, kind: "memory_reused", count: items })
          }}
        />
      )}
      {capture && captureWorkspace && (
        <CaptureDialog
          key={capture.nonce}
          open
          onOpenChange={(open) => !open && setCapture(null)}
          projectName={subjectName(captureWorkspace)}
          initialMode={capture.mode}
          onSaveConversations={(inputs) => saveConversations(captureWorkspace.id, inputs)}
          onSaveNote={(draft) => handleSaveNote(captureWorkspace.id, draft)}
        />
      )}
      <SaveFromAiDialog open={saveFromAiOpen} onOpenChange={setSaveFromAiOpen} />
      <AppSidebar
        onOpenSearch={() => openSearch()}
        workspaces={subjects}
        currentId={store.currentId}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        onMobileOpenChange={setMobileSidebarOpen}
        onSwitch={handleSwitchWorkspace}
        onOpenSubject={openSubject}
        onCreate={handleCreateWorkspace}
        onOpenHome={() => setView("home")}
        onOpenSessions={() => openSessions()}
        onOpenFavorites={() => setView("favorites")}
        onOpenRecents={() => setView("recents")}
        onOpenHistoryDump={() => setView("history-dump")}
        onOpenGraph={handleOpenGraph}
        onOpenAi={() => setView("ai")}
        onOpenLibrary={() => setView("library")}
        onOpenCommandMenu={paletteHost.open}
        createActions={{
          ...(subjects.length > 0 ? { onWriteNote: () => openCapture(currentWorkspace.id, "note"), onImportChats: () => openCapture(currentWorkspace.id, "import") } : {}),
          onSaveSession: () => openSessions({ save: true }),
        }}
        status={<ShellStatus canPersist={canPersist} desktop={isDesktopShell} onOpenExtension={() => openSettings("extension")} />}
        onOpenSettings={() => openSettings()}
        onOpenWorkspace={() => setView("workspace")}
        currentView={view}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {destination ?? (currentWorkspace.tabs.filter((tab) => !tab.resource).length === 0 ? (
          // A project with no saved tabs is its Knowledge Centre alone; dumping every open tab is still one field away.
          <ProjectPage
            key={currentWorkspace.id}
            workspace={currentWorkspace}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
            onBack={() => setView("home")}
            onRenameSubject={(name) => handleRenameWorkspace(currentWorkspace.id, name)}
            onUpdateSubjectLogo={(logo) => handleUpdateWorkspaceLogo(currentWorkspace.id, logo)}
            onDeleteSubject={() => {
              handleDeleteWorkspace(currentWorkspace.id)
              setView("home")
            }}
            canDeleteSubject={store.workspaces.length > 1}
          >
            {/* Pages Hubble noticed that may belong here: the same stored suggestion Home shows. */}
            {!isDesktopShell && <ProjectContextStrip workspace={currentWorkspace} projects={subjects} onAccept={handleAcceptSuggestion} />}
            {/* The older "paste every open tab, organize later" dump, one disclosure away. */}
            {projectHomeFor(currentWorkspace, <TabInput onDump={handleDump} />)}
          </ProjectPage>
        ) : (
          // Keyed on the workspace id so switching workspaces remounts
          // fresh — search/filter/sort/selection state from the previous
          // workspace has no business surviving into a different one.
          <WorkspaceView
            key={currentWorkspace.id}
            tabs={currentWorkspace.tabs}
            onTabsChange={handleTabsChange}
            onClear={handleClear}
            currentWorkspace={currentWorkspace}
            allWorkspaces={store.workspaces}
            onOpenGraph={() => showInGraph(`p:${currentWorkspace.id}`)}
            organizationStatus={
              <div className="flex items-center gap-2">
                <OrganizationStatusBar
                  state={readiness.state}
                  onRetry={retryDumpOrganization}
                  onDismissError={readiness.dismissError}
                />
                <SyncIndicator
                  state={syncState}
                  // Hidden entirely when there is no account to sync to,
                  // rather than offering a control that cannot work.
                  disabled={!auth?.user}
                  onSyncNow={() => sync.syncNow(currentWorkspace.id)}
                  onMigrate={() => void sync.migrate(currentWorkspace.id)}
                  onResolve={(conflictId, choice) => sync.resolve(currentWorkspace.id, conflictId, choice)}
                />
              </div>
            }
            onOpenFavorites={() => setView("favorites")}
            onOpenRecents={() => setView("recents")}
            onOpenHistoryDump={() => setView("history-dump")}
            onSwitchWorkspace={handleSwitchWorkspace}
            recentlyAddedIds={recentlyAddedIds}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
            {...(organizeOfferFor?.workspaceId === currentWorkspace.id ? { organizeOffer: organizeOfferFor.token } : {})}
            {...(!isDesktopShell ? { contextStrip: <ProjectContextStrip workspace={currentWorkspace} projects={subjects} onAccept={handleAcceptSuggestion} /> } : {})}
            onDismissOrganizeOffer={() => setOrganizeOfferFor(null)}
            onCreateSection={handleCreateSection}
            onRenameSection={handleRenameSection}
            onDeleteSection={handleDeleteSection}
            onAssignTabToSection={handleAssignTabToSection}
            onReorganizeSections={handleReorganizeSections}
            projectHome={projectHomeFor(currentWorkspace)}
            onBack={() => setView("home")}
            onRenameSubject={(name) => handleRenameWorkspace(currentWorkspace.id, name)}
            onUpdateSubjectLogo={(logo) => handleUpdateWorkspaceLogo(currentWorkspace.id, logo)}
            onDeleteSubject={() => {
              handleDeleteWorkspace(currentWorkspace.id)
              setView("home")
            }}
            canDeleteSubject={store.workspaces.length > 1}
          />
        ))}
      </div>
    </div>
    </MemoryActionsProvider>
    </ProjectActionsProvider>
    </CommandPaletteHostContext.Provider>
  )
}

/**
 * The rail's status line: the one connection that changes what Hubble can
 * do (Hubble for Chrome on the web), or a storage problem that means nothing
 * will be kept. Quiet when all is well; a link to the fix when it is not.
 */
function ShellStatus({ canPersist, desktop, onOpenExtension }: { canPersist: boolean; desktop: boolean; onOpenExtension: () => void }) {
  const connected = useBrowserConnected()
  if (!canPersist) {
    return (
      <p role="status" className="flex items-center gap-2 text-meta text-warning">
        <span aria-hidden className="size-1.5 rounded-full bg-warning" /> Not saving: storage is off
      </p>
    )
  }
  if (desktop) {
    return (
      <p className="flex items-center gap-2 text-meta text-tertiary">
        <span aria-hidden className="size-1.5 rounded-full bg-success" /> Saved on this computer
      </p>
    )
  }
  return (
    <button type="button" onClick={onOpenExtension} className="flex w-full items-center gap-2 rounded-xs text-left text-meta text-tertiary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60" data-shell-status={connected ? "connected" : "disconnected"}>
      <span aria-hidden className={connected ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full border border-strong"} />
      {connected ? "Hubble for Chrome connected" : "Hubble for Chrome not connected"}
    </button>
  )
}
