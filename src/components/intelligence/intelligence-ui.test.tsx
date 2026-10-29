import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// The extension, as the bridge sees it: every answer here is what Hubble for Chrome would say.
const bridge = vi.hoisted(() => ({
  settings: { version: 1, mode: "off", categories: ["ai", "docs", "research"], excludedHosts: [] as string[], paused: false, readConversations: [] as string[], retentionDays: 30 } as Record<string, unknown>,
  granted: [] as string[],
  otherAccount: false,
  error: undefined as undefined | "needs-update" | "not-connected",
  saved: [] as Record<string, unknown>[],
  accessAsked: [] as string[],
  cleared: 0,
  forgotten: [] as string[][],
  pull: undefined as undefined | (() => Promise<unknown>),
  /** When set, the settings answer waits for it — the extension still waking or verifying the account. */
  settingsGate: undefined as undefined | Promise<void>,
}))
vi.mock("@/lib/intelligence/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intelligence/bridge")>()
  const answer = () => (bridge.error ? { ok: false, error: bridge.error } : { ok: true, value: { settings: actual.readSettings(bridge.settings)!, granted: bridge.granted, incognitoAllowed: false, version: "0.10.0", otherAccount: bridge.otherAccount } })
  return {
    ...actual,
    getContextSettings: vi.fn(async () => {
      // Read when asked, like the extension reading its storage; delivered when the gate opens.
      const read = answer()
      if (bridge.settingsGate) await bridge.settingsGate
      return read
    }),
    setContextSettings: vi.fn(async (patch: Record<string, unknown>) => {
      if (bridge.error) return answer()
      bridge.saved.push(patch)
      bridge.settings = { ...bridge.settings, ...patch }
      return answer()
    }),
    requestConversationAccess: vi.fn(async (provider: string) => {
      bridge.accessAsked.push(provider)
      return { ok: true, value: { granted: false } }
    }),
    clearActivity: vi.fn(async () => {
      bridge.cleared += 1
      return { ok: true, value: { epoch: "e2" } }
    }),
    forgetActivity: vi.fn(async (keys: string[]) => {
      bridge.forgotten.push(keys)
      return { ok: true, value: { forgotten: keys.length } }
    }),
    pullActivity: vi.fn(async () => (bridge.pull ? bridge.pull() : { ok: false, error: "not-connected" })),
  }
})
const connection = vi.hoisted(() => ({ connected: true }))
vi.mock("@/hooks/use-tab-sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-tab-sessions")>()
  return { ...actual, useBrowserConnected: () => connection.connected }
})
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>()
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
  return { ...actual, toast }
})

import { HomeView } from "@/components/home/home-view"
import { useContextSync } from "@/hooks/use-context-intelligence"
import { ContextSection } from "@/components/settings/sections/context-section"
import { ContextOnboardingDialog } from "./context-onboarding"
import { ProjectContextStrip } from "./project-context-strip"
import { ResumePrompt } from "./resume-prompt"
import { SuggestionReviewDialog } from "./suggestion-review-dialog"
import { __resetContextForTests, getContextSnapshot, writeContext } from "@/lib/intelligence/persistence"
import { __resetSettingsViewForTests, refreshSettings, saveSettings } from "@/lib/intelligence/settings-store"
import { emptyContextState } from "@/lib/intelligence/state"
import { getSettingsView } from "@/lib/intelligence/settings-store"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { NOW, economicsArticles, economicsChat, project, source } from "@/lib/intelligence/__fixtures__/student-work"
import type { Suggestion } from "@/lib/intelligence/types"

const suggestion: Suggestion = {
  id: "sugg-1",
  dedupeKey: "save:econ",
  kind: "save-to-project",
  recordKeys: [economicsChat.key, economicsArticles[0]!.key, economicsArticles[1]!.key],
  destination: { kind: "project", workspaceId: "econ" },
  alternatives: [],
  confidence: 0.7,
  band: "strong",
  evidence: { sharedTerms: ["sugar", "tax"], nameTerms: ["economics"], days: 1, fromContent: true, semantic: 0.6, temporal: 1, feedbackPenalty: 0 },
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: NOW + 7 * 86_400_000,
  status: "open",
}

const econ = project("econ", "Economics IA", [source("https://www.tutor2u.net/economics/tax", "Indirect taxes")])
const history = project("history", "History essay", [source("https://www.britannica.com/event/Treaty-of-Versailles", "Treaty of Versailles")])

function seed(extra: Partial<ReturnType<typeof emptyContextState>> = {}) {
  writeContext(() => ({ ...emptyContextState(), records: [economicsChat, ...economicsArticles], suggestions: [suggestion], ...extra }))
}

beforeEach(() => {
  localStorage.clear()
  __resetContextForTests()
  __resetSettingsViewForTests()
  bridge.settings = { version: 1, mode: "off", categories: ["ai", "docs", "research"], excludedHosts: [], paused: false, readConversations: [], retentionDays: 30 }
  bridge.granted = []
  bridge.otherAccount = false
  bridge.error = undefined
  bridge.saved = []
  bridge.accessAsked = []
  bridge.cleared = 0
  bridge.forgotten = []
  bridge.pull = undefined
  bridge.settingsGate = undefined
  setStorageNamespace(null)
  connection.connected = true
})
afterEach(() => {
  __resetContextForTests()
  __resetSettingsViewForTests()
})

function Sync() {
  useContextSync({ workspaces: [econ, history], enabled: true })
  return null
}

describe("identity switches", () => {
  it("a pull answered after switching to another identity is dropped, never written to either", async () => {
    let answer: (value: unknown) => void = () => {}
    bridge.pull = () => new Promise((resolve) => (answer = resolve))
    setStorageNamespace("account-a")
    render(<Sync />)
    await waitFor(() => expect(bridge.pull).toBeDefined())
    await new Promise((resolve) => setTimeout(resolve, 50))
    // AuthProvider switches the namespace first; the old shell's effects are cleaned up after.
    setStorageNamespace("account-b")
    answer({ ok: true, value: { epoch: "e", seq: 1, reset: true, records: [economicsChat], removed: [], openKeys: [] } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(getContextSnapshot().records).toEqual([])
    setStorageNamespace("account-a")
    expect(getContextSnapshot().records).toEqual([])
  })

  it("one identity's settings are never shown to another", async () => {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW }
    setStorageNamespace("account-a")
    await act(async () => void (await refreshSettings()))
    expect(getSettingsView().status).toBe("ready")
    setStorageNamespace("account-b")
    expect(getSettingsView().status).toBe("unknown")
  })
})

describe("retention in Hubble's copy", () => {
  it("drops activity older than the person keeps, even with nothing pulled", async () => {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW, retentionDays: 7 }
    const old = { ...economicsArticles[2]!, firstSeenAt: Date.now() - 20 * 86_400_000, lastSeenAt: Date.now() - 10 * 86_400_000 }
    const fresh = { ...economicsArticles[0]!, lastSeenAt: Date.now() - 86_400_000 }
    writeContext(() => ({ ...emptyContextState(), records: [old, fresh] }))
    render(<Sync />)
    await waitFor(() => expect(getContextSnapshot().records.map((record) => record.key)).toEqual([fresh.key]), { timeout: 3000 })
  })
})

describe("manual mode", () => {
  it("suggests nothing from pages kept before, and puts away what was waiting", async () => {
    bridge.settings = { ...bridge.settings, mode: "off", decidedAt: NOW }
    seed()
    render(<Sync />)
    await waitFor(() => expect(getContextSnapshot().suggestions[0]!.status).toBe("expired"), { timeout: 3000 })
  })

  it("suggests nothing while the extension hasn't yet said what was chosen (a page load in manual mode)", async () => {
    let answered: () => void = () => {}
    bridge.settingsGate = new Promise((resolve) => (answered = resolve))
    bridge.settings = { ...bridge.settings, mode: "off", decidedAt: NOW }
    seed({ suggestions: [] })
    render(<Sync />)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(getContextSnapshot().suggestions).toEqual([])
    answered()
    await waitFor(() => expect(getSettingsView().status).toBe("ready"))
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(getContextSnapshot().suggestions.filter((entry) => entry.status === "open")).toEqual([])
  })

  it("suggests nothing new when the extension can't say what was chosen at all", async () => {
    bridge.error = "not-connected"
    seed({ suggestions: [] })
    render(<Sync />)
    await waitFor(() => expect(getSettingsView().status).toBe("unavailable"))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(getContextSnapshot().suggestions).toEqual([])
  })

  it("keeps suggesting when detection is on", async () => {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW }
    seed()
    render(<Sync />)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(getContextSnapshot().suggestions.some((suggestion) => suggestion.status === "open")).toBe(true)
  })
})

describe("settings answers out of order", () => {
  it("a refresh that read the settings before a change was saved never undoes the change on screen", async () => {
    let answered: () => void = () => {}
    bridge.settings = { ...bridge.settings, mode: "off", decidedAt: NOW }
    bridge.settingsGate = new Promise((resolve) => (answered = resolve))
    const refreshing = refreshSettings()
    bridge.settingsGate = undefined
    await saveSettings({ mode: "auto" })
    expect(getSettingsView()).toMatchObject({ status: "ready", value: { settings: { mode: "auto" } } })
    answered()
    await refreshing
    expect(getSettingsView()).toMatchObject({ status: "ready", value: { settings: { mode: "auto" } } })
    // A refresh after the save has landed is shown as usual.
    bridge.settings = { ...bridge.settings, mode: "sites" }
    await refreshSettings()
    expect(getSettingsView()).toMatchObject({ status: "ready", value: { settings: { mode: "sites" } } })
  })
})

describe("first-run choice", () => {
  function home(onAccept = vi.fn(async () => true)) {
    return render(<HomeView subjects={[econ]} firstRun={false} now={NOW} onOpenSubject={vi.fn()} onNewSubject={vi.fn()} onOpenItem={vi.fn()} context={{ connected: true, onAccept, onOpenSettings: vi.fn() }} />)
  }

  it("Home invites the person once the extension is connected and nothing was chosen", async () => {
    await act(async () => void (await refreshSettings()))
    home()
    expect(screen.getByRole("region", { name: "Context detection" })).toBeTruthy()
  })

  it("Not now defers it, and it does not come back on the next visit", async () => {
    await act(async () => void (await refreshSettings()))
    const { unmount } = home()
    await userEvent.click(within(screen.getByRole("region", { name: "Context detection" })).getByRole("button", { name: "Not now" }))
    expect(screen.queryByRole("region", { name: "Context detection" })).toBeNull()
    unmount()
    home()
    expect(screen.queryByRole("region", { name: "Context detection" })).toBeNull()
  })

  it("is not shown once a choice was made", async () => {
    bridge.settings = { ...bridge.settings, mode: "off", decidedAt: NOW - 1000 }
    await act(async () => void (await refreshSettings()))
    home()
    expect(screen.queryByRole("region", { name: "Context detection" })).toBeNull()
  })

  it("declining (manual mode) saves the choice and turns nothing on", async () => {
    render(<ContextOnboardingDialog open onOpenChange={vi.fn()} />)
    await userEvent.click(screen.getByRole("radio", { name: /Manual/ }))
    await userEvent.click(screen.getByRole("button", { name: "Use manual mode" }))
    await waitFor(() => expect(bridge.saved).toHaveLength(1))
    expect(bridge.saved[0]).toMatchObject({ mode: "off", readConversations: [], decidedAt: expect.any(Number) })
    expect(bridge.accessAsked).toEqual([])
  })

  it("chosen sites saves only the categories ticked", async () => {
    render(<ContextOnboardingDialog open onOpenChange={vi.fn()} />)
    await userEvent.click(screen.getByRole("radio", { name: /Only sites I choose/ }))
    await userEvent.click(screen.getByRole("checkbox", { name: "Documents" }))
    await userEvent.click(screen.getByRole("checkbox", { name: "Research" }))
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }))
    await waitFor(() => expect(bridge.saved).toHaveLength(1))
    expect(bridge.saved[0]).toMatchObject({ mode: "sites", categories: ["ai"] })
  })

  it("asks Chrome for each AI app ticked, and says when Chrome refused", async () => {
    const { toast } = await import("sonner")
    render(<ContextOnboardingDialog open onOpenChange={vi.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: /ChatGPT/ }))
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }))
    await waitFor(() => expect(bridge.accessAsked).toEqual(["chatgpt"]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Context detection is on", expect.objectContaining({ description: expect.stringMatching(/didn't allow reading ChatGPT/) })))
  })

  it("Later saves nothing", async () => {
    const onOpenChange = vi.fn()
    render(<ContextOnboardingDialog open onOpenChange={onOpenChange} />)
    await userEvent.click(screen.getByRole("button", { name: "Later" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(bridge.saved).toEqual([])
  })
})

describe("suggestions on Home", () => {
  function home(onAccept = vi.fn(async () => true)) {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW - 1000 }
    render(<HomeView subjects={[econ, history]} firstRun={false} now={NOW} onOpenSubject={vi.fn()} onNewSubject={vi.fn()} onOpenItem={vi.fn()} context={{ connected: true, onAccept, onOpenSettings: vi.fn() }} />)
    return onAccept
  }

  it("shows the suggestion with its pages, their real status, and what will happen", () => {
    seed()
    home()
    const card = screen.getByRole("article", { name: "Save a conversation and 2 pages to Economics IA?" })
    expect(within(card).getByText(/mention “sugar” and “tax”, like your project Economics IA/)).toBeTruthy()
    expect(within(card).getByText("Sugar tax effectiveness")).toBeTruthy()
    expect(within(card).getAllByText("Title only").length).toBe(2)
    expect(within(card).getByText("Read")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Save to Economics IA" })).toBeTruthy()
    // Shown once: marked as surfaced.
    expect(getContextSnapshot().suggestions[0]!.surfacedAt).toBeDefined()
  })

  it("accepting sends every page to the suggested project", async () => {
    seed()
    const onAccept = home()
    await userEvent.click(screen.getByRole("button", { name: "Save to Economics IA" }))
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: "sugg-1" }), { recordKeys: suggestion.recordKeys, destination: { kind: "project", workspaceId: "econ" } })
  })

  it("not relevant dismisses it everywhere and records the correction", async () => {
    seed()
    home()
    await userEvent.click(within(screen.getByRole("article")).getByRole("button", { name: /Not now/ }))
    await userEvent.click(await screen.findByRole("menuitem", { name: /Not relevant/ }))
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull())
    const state = getContextSnapshot()
    expect(state.suggestions[0]!.status).toBe("dismissed")
    expect(state.rejections.map((rejection) => rejection.target)).toEqual(["any", "any", "any"])
  })

  it("not now snoozes it", async () => {
    seed()
    home()
    await userEvent.click(within(screen.getByRole("article")).getByRole("button", { name: /Not now/ }))
    await userEvent.click(await screen.findByRole("menuitem", { name: /ask in a few days/ }))
    await waitFor(() => expect(getContextSnapshot().suggestions[0]!.status).toBe("snoozed"))
  })
})

describe("reviewing a suggestion", () => {
  const records = [economicsChat, ...economicsArticles]
  const projects = [
    { id: "econ", name: "Economics IA" },
    { id: "history", name: "History essay" },
  ]

  it("takes an item out, and the button says exactly what will happen", async () => {
    const onConfirm = vi.fn()
    render(<SuggestionReviewDialog suggestion={suggestion} records={records} projects={projects} onOpenChange={vi.fn()} onConfirm={onConfirm} />)
    expect(screen.getByRole("button", { name: "Add 3 items to Economics IA" })).toBeTruthy()
    await userEvent.click(screen.getByRole("checkbox", { name: `Include ${economicsArticles[1]!.title}` }))
    await userEvent.click(screen.getByRole("button", { name: "Add 2 items to Economics IA" }))
    expect(onConfirm).toHaveBeenCalledWith(suggestion, { recordKeys: [economicsChat.key, economicsArticles[0]!.key], destination: { kind: "project", workspaceId: "econ" } })
  })

  it("can go to a new project, which needs a name", async () => {
    const onConfirm = vi.fn()
    render(<SuggestionReviewDialog suggestion={suggestion} records={records} projects={projects} onOpenChange={vi.fn()} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole("button", { name: "Economics IA" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "New project…" }))
    const confirm = screen.getByRole("button", { name: /Create “project”/ }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await userEvent.type(screen.getByPlaceholderText("Project name"), "Sugar tax IA")
    await userEvent.click(screen.getByRole("button", { name: "Create “Sugar tax IA” with 3 items" }))
    expect(onConfirm).toHaveBeenCalledWith(suggestion, { recordKeys: suggestion.recordKeys, destination: { kind: "new-project", name: "Sugar tax IA" } })
  })

  it("says when a conversation will be saved as a link only", () => {
    render(<SuggestionReviewDialog suggestion={suggestion} records={records.map((record) => ({ ...record, open: false }))} projects={projects} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByText(/1 conversation is saved as a link/)).toBeTruthy()
  })
})

describe("inside a project", () => {
  it("one line names the pages that may belong here and opens the same review", async () => {
    seed()
    render(<ProjectContextStrip workspace={econ} projects={[econ, history]} onAccept={vi.fn(async () => true)} />)
    const strip = await screen.findByRole("status")
    expect(strip.textContent).toMatch(/3 pages may belong here/)
    await userEvent.click(within(strip).getByRole("button", { name: "Review" }))
    expect(await screen.findByRole("button", { name: "Add 3 items to Economics IA" })).toBeTruthy()
  })
})

describe("Smart Resume", () => {
  const recommendation = {
    workspaceId: "econ",
    lastAt: NOW - 2 * 86_400_000,
    summary: { counts: { conversation: 1, source: 2, file: 0, note: 0 }, latest: [{ title: "Sugar tax draft", kind: "source" as const, at: NOW - 86_400_000 }], linkOnlyConversations: 1, unreadable: 0, basis: "metadata" as const },
    newSinceCheckpoint: 2,
    waiting: 0,
    reason: "returning" as const,
  }

  it("shows the project's last state and reopens its tabs only when ticked", async () => {
    const onResume = vi.fn()
    render(<ResumePrompt recommendation={recommendation} workspace={econ} now={NOW} reopen={{ count: 4, label: "the 4 tabs from “IA writing”" }} onResume={onResume} onDismiss={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Continue Economics IA?" })).toBeTruthy()
    expect(screen.getByText("2 new since you last picked it up")).toBeTruthy()
    expect(screen.getByText(/saved as a link only/)).toBeTruthy()
    expect(screen.getByText(/not a summary of what they say/)).toBeTruthy()
    await userEvent.click(screen.getByRole("checkbox", { name: "Reopen the 4 tabs from “IA writing”" }))
    await userEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(onResume).toHaveBeenCalledWith({ reopenTabs: false })
  })
})

describe("Settings → Context", () => {
  it("says when the extension isn't connected, and still lets the person clear what Hubble holds", async () => {
    connection.connected = false
    seed()
    render(<ContextSection />)
    expect(screen.getByText("Connect Hubble for Chrome to set this up.")).toBeTruthy()
    await userEvent.click(screen.getAllByRole("button", { name: "Clear activity" })[0]!)
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear activity" }))
    await waitFor(() => expect(getContextSnapshot().records).toHaveLength(0))
    expect(bridge.cleared).toBe(0)
  })

  it("asks for an update when the extension predates context detection", async () => {
    bridge.error = "needs-update"
    render(<ContextSection />)
    expect(await screen.findByText(/older than this feature/)).toBeTruthy()
  })

  it("shows a revoked permission honestly", async () => {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW, readConversations: ["chatgpt"] }
    bridge.granted = []
    render(<ContextSection />)
    expect(await screen.findByText(/Waiting for Chrome's permission/)).toBeTruthy()
    expect((screen.getByRole("switch", { name: "Read ChatGPT conversations" }) as HTMLElement).getAttribute("aria-checked")).toBe("true")
  })

  it("removes one detected page here and in the extension, without touching projects", async () => {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW }
    localStorage.setItem("tabdump:workspaces:v1", JSON.stringify({ version: 1, currentId: "econ", workspaces: [econ] }))
    seed()
    render(<ContextSection />)
    await userEvent.click(await screen.findByRole("button", { name: `Remove ${economicsChat.title}` }))
    await waitFor(() => expect(bridge.forgotten).toEqual([[economicsChat.key]]))
    expect(getContextSnapshot().records.map((record) => record.key)).not.toContain(economicsChat.key)
    expect(getContextSnapshot().suggestions[0]!.recordKeys).not.toContain(economicsChat.key)
    expect(JSON.parse(localStorage.getItem("tabdump:workspaces:v1")!).workspaces[0].tabs).toHaveLength(1)
  })

  it("excluding a site goes to the extension, which enforces it", async () => {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW }
    render(<ContextSection />)
    await userEvent.type(await screen.findByRole("textbox", { name: "Site to never detect" }), "https://www.reddit.com/r/x")
    await userEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(bridge.saved.at(-1)).toMatchObject({ excludedHosts: ["reddit.com"] }))
  })

  it("excluding a site also drops Hubble's copy and every answer that names it", async () => {
    bridge.settings = { ...bridge.settings, mode: "auto", decidedAt: NOW }
    const excluded = economicsArticles[0]!
    seed({ rejections: [{ key: excluded.key, target: "any", at: NOW, terms: ["sugar"] }] })
    render(<ContextSection />)
    await userEvent.type(await screen.findByRole("textbox", { name: "Site to never detect" }), excluded.domain)
    await userEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(getContextSnapshot().records.map((record) => record.key)).not.toContain(excluded.key))
    expect(getContextSnapshot().rejections).toEqual([])
    expect(getContextSnapshot().suggestions[0]!.recordKeys).not.toContain(excluded.key)
  })

  it("says when another Hubble account on this Chrome set detection up", async () => {
    bridge.otherAccount = true
    render(<ContextSection />)
    expect(await screen.findByText(/Another Hubble account on this Chrome set this up/)).toBeTruthy()
  })
})
