import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import { historyApprovalOf, historyChangeOf, historyEventOf } from "@/lib/agents/activity/history"
import type { AgentHistoryDetail, AgentHistorySession } from "@/lib/agents/activity/history"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import { contextCountsLine } from "@/lib/agents/control/events"
import { buildHandoffEnvelope, handoffLinksOf } from "@/lib/agents/handoff/handoff"
import type { SessionHandoff } from "@/lib/agents/handoff/handoff"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentIdentity } from "@/lib/agents/platform/roster"
import type { RuntimeApprovalView, RuntimeSessionContextView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import type { Collection } from "@/lib/collections/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Section } from "@/lib/sections/types"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"
import { AUTH_FIX_EDIT, DEMO_PROJECT_ID, DEMO_PROJECT_NAME, demoProjectChange } from "./demo-project"
import { projectChangeTitle } from "@/lib/agents/project/changes"
import { verificationTitle } from "@/lib/agents/project/checks"

/*
 * The landing page demo's world.
 *
 * Every value here is typed as the product's own domain type — workspaces,
 * tabs, sections, collections, dependencies, agent identities, runtime
 * session views, control events and approvals — so the real components render
 * it exactly as they would render a user's data, and the fixture stops
 * type-checking the moment the product stops supporting a shape it describes.
 *
 * It is synthetic: the sites are real public pages a person might keep open,
 * but the workspaces, notes, sessions and conversations are invented for the
 * demo. Hubble's own pages use `hubble.example`, a reserved domain, so nothing
 * here points at a URL that pretends to be a real Hubble property.
 *
 * Deterministic on purpose. One fixed clock and fixed ids, no randomness, so
 * the server render and the browser agree and the page reads the same on
 * every visit.
 */

/** The demo's clock. Every relative time on the page is measured from here. */
export const DEMO_NOW = Date.UTC(2026, 8, 25, 16, 0, 0)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// ---------------------------------------------------------------- tabs

function tab(
  id: string,
  url: string,
  title: string,
  extra: Partial<Tab> & { sectionId?: string } = {}
): Tab {
  const parsed = new URL(url)
  const domain = parsed.hostname.replace(/^www\./, "")
  return {
    id,
    url,
    normalizedUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/$/, ""),
    domain,
    title,
    createdAt: DEMO_NOW - 3 * DAY,
    updatedAt: DEMO_NOW - 3 * DAY,
    organizationStatus: "classified",
    ...extra,
  }
}

function section(id: string, name: string, parentId: string | null = null): Section {
  return { id, parentId, name, source: "ai", createdAt: DEMO_NOW - 3 * DAY, updatedAt: DEMO_NOW - 3 * DAY }
}

export const RESEARCH_ID = "w-research"
export const BUILD_ID = "w-hubble-build"
export const SEMESTER_ID = "w-semester"

const RESEARCH_SECTIONS: Section[] = [
  section("s-papers", "Papers"),
  section("s-benchmarks", "Benchmarks", "s-papers"),
  section("s-agents", "Agents & tools"),
  section("s-product", "Product"),
  section("s-learning", "Learning"),
]

const RESEARCH_TABS: Tab[] = [
  tab("t-attention", "https://arxiv.org/abs/1706.03762", "Attention Is All You Need", {
    category: "research",
    sectionId: "s-papers",
    isFavorite: true,
    lastAccessedAt: DEMO_NOW - 2 * HOUR,
    notes: "Start here. Section 3 is the part the agents papers keep citing.",
  }),
  tab("t-react", "https://arxiv.org/abs/2210.03629", "ReAct: Synergizing Reasoning and Acting in Language Models", {
    category: "research",
    sectionId: "s-papers",
    lastAccessedAt: DEMO_NOW - 5 * HOUR,
  }),
  tab("t-toolformer", "https://arxiv.org/abs/2302.04761", "Toolformer: Language Models Can Teach Themselves to Use Tools", {
    category: "research",
    sectionId: "s-papers",
  }),
  tab("t-swe-paper", "https://arxiv.org/abs/2310.06770", "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?", {
    category: "research",
    sectionId: "s-benchmarks",
    lastAccessedAt: DEMO_NOW - 40 * MIN,
  }),
  tab("t-swe-board", "https://www.swebench.com/", "SWE-bench Leaderboard", {
    category: "research",
    sectionId: "s-benchmarks",
    lastAccessedAt: DEMO_NOW - 35 * MIN,
  }),
  tab("t-swe-repo", "https://github.com/SWE-bench/SWE-bench", "SWE-bench/SWE-bench", {
    category: "research",
    sectionId: "s-benchmarks",
  }),
  tab("t-claude", "https://claude.ai/", "Claude", {
    category: "projects",
    sectionId: "s-agents",
    isFavorite: true,
    lastAccessedAt: DEMO_NOW - 12 * MIN,
  }),
  tab("t-claude-code", "https://docs.anthropic.com/en/docs/claude-code/overview", "Claude Code overview", {
    category: "research",
    sectionId: "s-agents",
    lastAccessedAt: DEMO_NOW - 3 * HOUR,
  }),
  tab("t-cursor", "https://cursor.com/", "Cursor", {
    category: "projects",
    sectionId: "s-agents",
    lastAccessedAt: DEMO_NOW - 26 * HOUR,
  }),
  tab("t-gemini-cli", "https://github.com/google-gemini/gemini-cli", "google-gemini/gemini-cli", {
    category: "projects",
    sectionId: "s-agents",
  }),
  tab("t-mcp", "https://modelcontextprotocol.io/", "Model Context Protocol", {
    category: "research",
    sectionId: "s-agents",
    isFavorite: true,
  }),
  tab("t-acp", "https://agentclientprotocol.com/", "Agent Client Protocol", {
    category: "research",
    sectionId: "s-agents",
  }),
  tab("t-hubble-docs", "https://docs.hubble.example/command-centre", "Hubble docs · Command Centre", {
    category: "projects",
    sectionId: "s-product",
    lastAccessedAt: DEMO_NOW - 90 * MIN,
  }),
  tab("t-hubble-context", "https://docs.hubble.example/workspace-context", "Hubble docs · Workspace context for agents", {
    category: "projects",
    sectionId: "s-product",
  }),
  tab("t-linear", "https://linear.app/", "Linear", { category: "projects", sectionId: "s-product" }),
  tab("t-figma", "https://www.figma.com/", "Figma", { category: "creative", sectionId: "s-product" }),
  tab("t-hn", "https://news.ycombinator.com/", "Hacker News", {
    category: "news",
    sectionId: "s-product",
    lastAccessedAt: DEMO_NOW - 8 * HOUR,
  }),
  tab("t-ocw", "https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/", "Linear Algebra — MIT OpenCourseWare", {
    category: "school",
    sectionId: "s-learning",
  }),
  tab("t-khan", "https://www.khanacademy.org/math/statistics-probability", "Statistics and probability — Khan Academy", {
    category: "school",
    sectionId: "s-learning",
  }),
  tab("t-hubble-wiki", "https://en.wikipedia.org/wiki/Hubble_Space_Telescope", "Hubble Space Telescope — Wikipedia", {
    category: "read-later",
    sectionId: "s-learning",
  }),
]

const BUILD_SECTIONS: Section[] = [section("b-release", "Release"), section("b-desktop", "Desktop"), section("b-infra", "Infrastructure")]

const BUILD_TABS: Tab[] = [
  tab("b-next", "https://nextjs.org/docs", "Next.js Docs", { category: "projects", sectionId: "b-release", lastAccessedAt: DEMO_NOW - 20 * MIN }),
  tab("b-vercel", "https://vercel.com/docs/deployments", "Deployments — Vercel Docs", { category: "projects", sectionId: "b-release" }),
  tab("b-changelog", "https://docs.hubble.example/changelog", "Hubble docs · Changelog", { category: "projects", sectionId: "b-release", isFavorite: true }),
  tab("b-tauri", "https://v2.tauri.app/start/", "Tauri 2.0 — Getting started", { category: "projects", sectionId: "b-desktop" }),
  tab("b-webview", "https://learn.microsoft.com/microsoft-edge/webview2/", "WebView2 documentation", { category: "projects", sectionId: "b-desktop" }),
  tab("b-postgres", "https://www.postgresql.org/docs/current/", "PostgreSQL Documentation", { category: "projects", sectionId: "b-infra" }),
  tab("b-sdk", "https://docs.anthropic.com/en/docs/claude-code/sdk", "Claude Agent SDK", { category: "research", sectionId: "b-infra", lastAccessedAt: DEMO_NOW - 4 * HOUR }),
  tab("b-mcp-spec", "https://modelcontextprotocol.io/specification", "MCP specification", { category: "research", sectionId: "b-infra" }),
  tab("b-next-dup", "https://nextjs.org/docs", "Next.js Docs", { category: "projects", sectionId: "b-release", isDuplicate: true }),
]

const SEMESTER_SECTIONS: Section[] = [section("m-math", "Linear algebra"), section("m-writing", "Essays")]

/*
 * Development (Hubble 1.6): a workspace about one project. Its tabs are what
 * someone fixing sign-in keeps open; its project is `hubble`, attached.
 */
export const DEVELOPMENT_ID = "w-development"

const DEVELOPMENT_SECTIONS: Section[] = [section("d-auth", "Authentication"), section("d-platform", "Platform")]

const DEVELOPMENT_TABS: Tab[] = [
  tab("d-route-handlers", "https://nextjs.org/docs/app/building-your-application/routing/route-handlers", "Route Handlers — Next.js", { category: "projects", sectionId: "d-auth", lastAccessedAt: DEMO_NOW - 12 * MIN }),
  tab("d-cookies", "https://nextjs.org/docs/app/api-reference/functions/cookies", "cookies — Next.js", { category: "projects", sectionId: "d-auth" }),
  tab("d-owasp", "https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html", "Session Management Cheat Sheet — OWASP", { category: "projects", sectionId: "d-auth", isFavorite: true }),
  tab("d-zod", "https://zod.dev/", "Zod — TypeScript-first schema validation", { category: "projects", sectionId: "d-auth" }),
  tab("d-mdn-cookies", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies", "Using HTTP cookies — MDN", { category: "projects", sectionId: "d-auth" }),
  tab("d-vitest", "https://vitest.dev/guide/", "Getting Started — Vitest", { category: "projects", sectionId: "d-platform" }),
]

/** Development's brief: the person's own words. */
export const DEVELOPMENT_BRIEF = {
  description: "The Hubble web app.",
  focus: "Authentication: sign-in accepts a wrong password.",
  updatedAt: DEMO_NOW - 2 * HOUR,
} as const

const SEMESTER_TABS: Tab[] = [
  tab("m-ocw", "https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/", "Linear Algebra — MIT OpenCourseWare", { category: "school", sectionId: "m-math" }),
  tab("m-3b1b", "https://www.3blue1brown.com/topics/linear-algebra", "Essence of linear algebra — 3Blue1Brown", { category: "school", sectionId: "m-math", isFavorite: true }),
  tab("m-khan", "https://www.khanacademy.org/math/linear-algebra", "Linear algebra — Khan Academy", { category: "school", sectionId: "m-math" }),
  tab("m-docs", "https://docs.google.com/", "Google Docs", { category: "school", sectionId: "m-writing", lastAccessedAt: DEMO_NOW - 30 * MIN }),
  tab("m-scholar", "https://scholar.google.com/", "Google Scholar", { category: "research", sectionId: "m-writing" }),
  tab("m-zotero", "https://www.zotero.org/", "Zotero", { category: "school", sectionId: "m-writing" }),
]

function workspace(id: string, name: string, tabs: Tab[], sections: Section[]): Workspace {
  return { id, name, tabs, sections, createdAt: DEMO_NOW - 14 * DAY, updatedAt: DEMO_NOW - HOUR }
}

/** Research's brief (Hubble 1.5): the person's own two lines, as they would write them. */
export const RESEARCH_BRIEF = {
  description: "Reading on AI agents and product ideas for Hubble.",
  focus: "Comparing how coding agents are evaluated, starting with SWE-bench.",
  updatedAt: DEMO_NOW - DAY,
} as const

export const DEMO_WORKSPACES: readonly Workspace[] = [
  { ...workspace(RESEARCH_ID, "Research", RESEARCH_TABS, RESEARCH_SECTIONS), brief: { ...RESEARCH_BRIEF } },
  workspace(BUILD_ID, "Hubble Build", BUILD_TABS, BUILD_SECTIONS),
  workspace(SEMESTER_ID, "Semester", SEMESTER_TABS, SEMESTER_SECTIONS),
  // Hubble 1.6: the workspace's project is attached — a reference by id, as the app stores it.
  {
    ...workspace(DEVELOPMENT_ID, "Development", DEVELOPMENT_TABS, DEVELOPMENT_SECTIONS),
    brief: { ...DEVELOPMENT_BRIEF },
    project: { projectId: DEMO_PROJECT_ID, attachedAt: DEMO_NOW - 3 * DAY },
  },
]

// --------------------------------------------------------- collections

function collection(id: string, workspaceId: string, name: string, tabIds: string[]): Collection {
  return { id, workspaceId, name, tabIds, createdAt: DEMO_NOW - 2 * DAY, updatedAt: DEMO_NOW - 2 * DAY }
}

// Each collection's tabs share one section. The graph draws a collection as
// the box around its members and keeps each member in its own category's
// ground, so a collection spanning two sections is drawn as a box stretched
// across the gap between them — right for a real workspace, wrong for a demo.
export const DEMO_COLLECTIONS: readonly Collection[] = [
  collection("c-ai-research", RESEARCH_ID, "AI Research", ["t-attention", "t-react", "t-toolformer"]),
  collection("c-product-ideas", RESEARCH_ID, "Product Ideas", ["t-linear", "t-figma", "t-hn"]),
  collection("c-hubble", RESEARCH_ID, "Hubble", ["t-hubble-docs", "t-hubble-context"]),
  collection("c-school", RESEARCH_ID, "School", ["t-ocw", "t-khan"]),
  collection("c-release", BUILD_ID, "Release checklist", ["b-next", "b-vercel", "b-changelog"]),
  collection("c-essay", SEMESTER_ID, "Essay sources", ["m-scholar", "m-zotero"]),
  collection("c-api", DEVELOPMENT_ID, "API", ["d-route-handlers", "d-cookies", "d-owasp"]),
]

export const DEMO_DEPENDENCIES: readonly TabDependency[] = [
  { id: "d-board-paper", parentTabId: "t-swe-board", childTabId: "t-swe-paper", type: "research", createdAt: DEMO_NOW - DAY },
  { id: "d-repo-paper", parentTabId: "t-swe-repo", childTabId: "t-swe-paper", type: "reference", createdAt: DEMO_NOW - DAY },
  { id: "d-context-mcp", parentTabId: "t-hubble-context", childTabId: "t-mcp", type: "reference", createdAt: DEMO_NOW - DAY },
]

// --------------------------------------------------------------- agents

/**
 * Connected agents, as the roster keeps them. Codex works in Development, on
 * its project (Hubble 1.6).
 */
export const DEMO_AGENTS: readonly AgentIdentity[] = (
  [
    ["claude-code", "Claude Code", RESEARCH_ID],
    ["gemini", "Gemini CLI", RESEARCH_ID],
    ["grok", "Grok Build", BUILD_ID],
    ["openai-codex", "Codex", DEVELOPMENT_ID],
  ] as const
).map(([provider, name, workspaceId]) => ({
  id: `agent:${provider}`,
  provider,
  name,
  connectedAt: DEMO_NOW - 5 * DAY,
  approvedScopes: ["read_workspace", "read_project", "write_project", "mcp_tools", ...(provider === "openai-codex" ? (["run_commands"] as const) : [])],
  approvedAt: DEMO_NOW - 5 * DAY,
  ...(workspaceId ? { workspaceId } : {}),
}))

/** Who Hubble will start sessions with — the catalog's own answer, restated for the demo's roster. */
export const DEMO_SESSION_PROVIDERS: ReadonlySet<AgentProviderId> = new Set(["claude-code", "gemini", "openai-codex", "grok"])

/** A session's workspace context as the runtime reports it. Exported for the demo's handoff target. */
export function demoSessionContext(workspaceId: string, workspaceName: string, write: boolean): RuntimeSessionContextView {
  return context(workspaceId, workspaceName, write)
}

function context(workspaceId: string, workspaceName: string, write: boolean): RuntimeSessionContextView {
  return {
    workspaceId,
    workspaceName,
    capabilities: [
      "workspace.read",
      "tabs.read",
      "collections.read",
      "relationships.read",
      ...(write ? (["collections.write"] as const) : []),
    ],
    version: 3,
    syncedAt: DEMO_NOW - 2 * MIN,
    fingerprint: "demo",
    pendingActions: [],
  }
}

function session(
  view: Partial<RuntimeSessionView> & Pick<RuntimeSessionView, "sessionId" | "provider" | "status">
): CommandCentreSession {
  return {
    origin: "controlled",
    view: {
      runIds: [`${view.sessionId}-run-1`],
      awaitingApproval: false,
      cancellable: false,
      resumable: true,
      latestSequence: 0,
      createdAt: DEMO_NOW - HOUR,
      updatedAt: DEMO_NOW,
      ...view,
    },
  }
}

export const CLAUDE_SESSION = "session-claude-swe"
export const GEMINI_SESSION = "session-gemini-ideas"
export const GROK_SESSION = "session-grok-duplicates"
export const CLAUDE_RELEASE_SESSION = "session-claude-release"

export const DEMO_PROJECTS = [
  { id: "project-hubble-web", name: "hubble-web" },
  { id: DEMO_PROJECT_ID, name: DEMO_PROJECT_NAME },
] as const

/** Codex fixing sign-in in Development's project (Hubble 1.6). */
export const CODEX_AUTH_SESSION = "session-codex-auth"

export const DEMO_SESSIONS: readonly CommandCentreSession[] = [
  session({
    sessionId: CLAUDE_SESSION,
    provider: "claude-code",
    status: "waiting_for_approval",
    title: "Summarize the SWE-bench reading list",
    awaitingApproval: true,
    cancellable: true,
    updatedAt: DEMO_NOW - 1 * MIN,
    workspaceId: RESEARCH_ID,
    context: context(RESEARCH_ID, "Research", true),
  }),
  session({
    sessionId: GEMINI_SESSION,
    provider: "gemini",
    status: "running",
    title: "Group Product Ideas by theme",
    cancellable: true,
    updatedAt: DEMO_NOW - 3 * MIN,
    workspaceId: RESEARCH_ID,
    context: context(RESEARCH_ID, "Research", false),
  }),
  session({
    sessionId: GROK_SESSION,
    provider: "grok",
    status: "completed",
    title: "Find duplicate docs tabs",
    updatedAt: DEMO_NOW - 42 * MIN,
    workspaceId: BUILD_ID,
    context: context(BUILD_ID, "Hubble Build", false),
  }),
  session({
    sessionId: CLAUDE_RELEASE_SESSION,
    provider: "claude-code",
    status: "completed",
    title: "Draft release notes for 0.9",
    projectId: DEMO_PROJECTS[0].id,
    updatedAt: DEMO_NOW - 5 * HOUR,
    workspaceId: BUILD_ID,
    context: context(BUILD_ID, "Hubble Build", false),
  }),
  session({
    sessionId: CODEX_AUTH_SESSION,
    provider: "openai-codex",
    status: "waiting_for_approval",
    title: "Fix the authentication bug",
    awaitingApproval: true,
    cancellable: true,
    projectId: DEMO_PROJECT_ID,
    updatedAt: DEMO_NOW - 2 * MIN,
    workspaceId: DEVELOPMENT_ID,
    context: context(DEVELOPMENT_ID, "Development", false),
    // Pointed at the API collection and two more tabs: five tabs in all.
    focus: { tabIds: ["d-zod", "d-mdn-cookies"], collectionIds: ["c-api"], delivered: true },
  }),
]

// --------------------------------------------------------------- events

/** Hubble's context tools as Claude Code names them: the minted server shape the Command Centre recognises. */
export function contextTool(name: string, callId?: string) {
  return { name: `mcp__tabdump_hubbledemosessio__${name}`, ...(callId ? { callId } : {}) }
}

/**
 * What Hubble's context server reports about its own answer — the event the
 * runtime raises after each read (see session-context/activity.ts). Counts
 * only, and here derived from the fixture itself, so the timeline's numbers
 * are the workspace's.
 */
function contextRead(workspaceId: string, operation: string, counts: { tabs?: number; collections?: number; matches?: number; groups?: number }) {
  const context = { workspaceId, operation, ok: true, ...counts }
  // Summarised as the control service summarises it.
  return { kind: "context_read" as const, summary: contextCountsLine(context), context }
}

function contextLoaded(workspaceId: string) {
  const workspace = DEMO_WORKSPACES.find((candidate) => candidate.id === workspaceId)!
  const context = {
    workspaceId,
    tabs: workspace.tabs.length,
    collections: DEMO_COLLECTIONS.filter((collection) => collection.workspaceId === workspaceId).length,
  }
  return { kind: "context_loaded" as const, summary: contextCountsLine(context), context }
}

const researchCollections = () => DEMO_COLLECTIONS.filter((collection) => collection.workspaceId === RESEARCH_ID)
const productIdeas = () => DEMO_COLLECTIONS.find((collection) => collection.id === "c-product-ideas")!

type EventInput = Partial<SequencedControlEvent> & Pick<SequencedControlEvent, "kind" | "summary">

export function buildEvents(sessionId: string, provider: AgentProviderId, inputs: readonly EventInput[], startAt: number): SequencedControlEvent[] {
  return inputs.map((input, index) => ({
    id: `${sessionId}-e${index + 1}`,
    sessionId,
    provider,
    timestamp: startAt + index * 4_000,
    sequence: index + 1,
    ...input,
  }))
}

/*
 * The approval as the broker reports it: Hubble's own reason and target
 * lines for a workspace change (session-context/registry.ts), and the
 * `write_workspace` scope every workspace change is asked under.
 */
export const SWE_APPROVAL: RuntimeApprovalView = {
  approvalId: "approval-swe-collection",
  sessionId: CLAUDE_SESSION,
  provider: "claude-code",
  action: "change_workspace",
  scope: "write_workspace",
  workspaceId: RESEARCH_ID,
  targets: [
    `New collection "SWE-bench"`,
    "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?",
    "SWE-bench Leaderboard",
    "SWE-bench/SWE-bench",
  ],
  reason: "Create a collection in this workspace.",
  change: {
    kind: "create_collection",
    subject: "SWE-bench",
    tabCount: 3,
    details: [
      "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?",
      "SWE-bench Leaderboard",
      "SWE-bench/SWE-bench",
    ],
  },
  requestedAt: DEMO_NOW - 1 * MIN,
  expiresAt: DEMO_NOW + 4 * MIN,
}

/** The tabs the approved collection would hold — the same three the card names. */
export const SWE_TAB_IDS = ["t-swe-paper", "t-swe-board", "t-swe-repo"] as const

/** Claude Code's call that proposed the collection, answered once the change is applied. */
export const SWE_CALL_ID = "claude-call-4"

export const RELEASE_APPROVAL: RuntimeApprovalView = {
  approvalId: "approval-release-edit",
  sessionId: CLAUDE_RELEASE_SESSION,
  provider: "claude-code",
  action: "modify_files",
  scope: "write_project",
  projectId: DEMO_PROJECTS[0].id,
  targets: ["CHANGELOG.md"],
  reason: "Add a 0.9 section with the three changes from the Release checklist.",
  requestedAt: DEMO_NOW - 5 * HOUR - 9 * MIN,
  expiresAt: DEMO_NOW - 5 * HOUR + MIN,
}

/**
 * Codex asks to change two project files (Hubble 1.6): the approval as the
 * broker reports it, with the runtime's note on each file.
 */
export const AUTH_APPROVAL: RuntimeApprovalView = {
  approvalId: "approval-auth-fix",
  sessionId: CODEX_AUTH_SESSION,
  provider: "openai-codex",
  action: "modify_files",
  scope: "write_project",
  projectId: DEMO_PROJECT_ID,
  targets: AUTH_FIX_EDIT.files.map((file) => file.path),
  projectFiles: AUTH_FIX_EDIT.files.map((file) => ({ path: file.path })),
  reason: "Await the password check and harden the session cookie.",
  requestedAt: DEMO_NOW - 2 * MIN,
  expiresAt: DEMO_NOW + 8 * MIN,
}

/**
 * Approvals the demo's sessions asked for, as the broker reported them —
 * what the Command Centre remembers about an approval once it is answered,
 * so the decision on the timeline can still say what was approved.
 */
export const DEMO_KNOWN_APPROVALS: ReadonlyMap<string, RuntimeApprovalView> = new Map(
  [SWE_APPROVAL, RELEASE_APPROVAL, AUTH_APPROVAL].map((approval) => [approval.approvalId, approval])
)

export const DEMO_EVENTS: Readonly<Record<string, readonly SequencedControlEvent[]>> = {
  [CLAUDE_SESSION]: buildEvents(
    CLAUDE_SESSION,
    "claude-code",
    [
      { kind: "session_started", summary: "Session started." },
      contextLoaded(RESEARCH_ID),
      {
        kind: "message_sent",
        summary: "Message sent.",
        messageId: "claude-m1",
        text: "Read the SWE-bench tabs in Research and tell me what each one is. If they belong together, put them in a collection.",
      },
      { kind: "thinking", summary: "Planning the summary" },
      { kind: "tool_started", summary: "Reading Research", tool: contextTool("get_workspace_summary", "claude-call-1") },
      contextRead(RESEARCH_ID, "get_workspace_summary", { tabs: RESEARCH_TABS.length, collections: researchCollections().length }),
      { kind: "tool_started", summary: "Searching for SWE-bench", tool: contextTool("search_tabs", "claude-call-2") },
      contextRead(RESEARCH_ID, "search_tabs", { matches: SWE_TAB_IDS.length }),
      { kind: "tool_started", summary: "Checking existing collections", tool: contextTool("find_relevant_collections", "claude-call-3") },
      // None of Research's collections holds a SWE-bench tab, so none is relevant.
      contextRead(RESEARCH_ID, "find_relevant_collections", {
        collections: researchCollections().filter((collection) => collection.tabIds.some((id) => (SWE_TAB_IDS as readonly string[]).includes(id))).length,
      }),
      {
        kind: "message_received",
        summary: "Reply",
        messageId: "claude-m2",
        text:
          "Three tabs are about SWE-bench: the paper that introduced it, its public leaderboard, and the benchmark's repository. None of your collections covers them yet.\n\nI'd like to group them into a new collection, “SWE-bench”.",
      },
      { kind: "tool_started", summary: "Proposing “SWE-bench”", tool: contextTool("create_collection", SWE_CALL_ID) },
      // Hubble's own event for a workspace change, in the control service's words.
      { kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: SWE_APPROVAL.approvalId },
    ],
    DEMO_NOW - 3 * MIN
  ),
  [GEMINI_SESSION]: buildEvents(
    GEMINI_SESSION,
    "gemini",
    [
      { kind: "session_started", summary: "Session started." },
      contextLoaded(RESEARCH_ID),
      {
        kind: "message_sent",
        summary: "Message sent.",
        messageId: "gemini-m1",
        text: "Look at Product Ideas and suggest themes. Don't change anything yet.",
      },
      { kind: "tool_started", summary: "Reading Product Ideas", tool: contextTool("get_collection", "gemini-call-1") },
      contextRead(RESEARCH_ID, "get_collection", { tabs: productIdeas().tabIds.length }),
      { kind: "tool_started", summary: "Grouping tabs by topic", tool: contextTool("analyze_topics", "gemini-call-2") },
      // The two themes the reply names, over the collection's tabs.
      contextRead(RESEARCH_ID, "analyze_topics", { groups: 2, tabs: productIdeas().tabIds.length }),
      {
        kind: "message_delta",
        summary: "Reply",
        messageId: "gemini-m2",
        text: "Two themes so far: planning tools (Linear, Figma) and where people discuss what they build (Hacker News). I'm checking the rest of Research for",
      },
    ],
    DEMO_NOW - 6 * MIN
  ),
  [GROK_SESSION]: buildEvents(
    GROK_SESSION,
    "grok",
    [
      { kind: "session_started", summary: "Session started." },
      contextLoaded(BUILD_ID),
      { kind: "message_sent", summary: "Message sent.", messageId: "grok-m1", text: "Are there duplicate tabs in Hubble Build?" },
      { kind: "tool_started", summary: "Looking for duplicates", tool: contextTool("find_duplicate_tabs", "grok-call-1") },
      contextRead(BUILD_ID, "find_duplicate_tabs", { groups: BUILD_TABS.filter((tab) => tab.isDuplicate).length }),
      {
        kind: "message_received",
        summary: "Reply",
        messageId: "grok-m2",
        text: "One: “Next.js Docs” is saved twice with the same address. Workspace cleanup can remove the extra copy — I haven't changed anything.",
      },
      { kind: "run_completed", summary: "Run completed." },
    ],
    DEMO_NOW - 50 * MIN
  ),
  [CLAUDE_RELEASE_SESSION]: buildEvents(
    CLAUDE_RELEASE_SESSION,
    "claude-code",
    [
      { kind: "session_started", summary: "Session started." },
      contextLoaded(BUILD_ID),
      {
        kind: "message_sent",
        summary: "Message sent.",
        messageId: "release-m1",
        text: "Draft release notes for 0.9 from the Release checklist collection and the changelog in the project.",
      },
      { kind: "tool_started", summary: "Reading Release checklist", tool: contextTool("get_collection", "release-call-1") },
      contextRead(BUILD_ID, "get_collection", {
        tabs: DEMO_COLLECTIONS.find((collection) => collection.name === "Release checklist")!.tabIds.length,
      }),
      { kind: "file_read", summary: "Read CHANGELOG.md", file: { relativePath: "CHANGELOG.md", projectId: DEMO_PROJECTS[0].id } },
      { kind: "file_read", summary: "Read docs/command-centre.md", file: { relativePath: "docs/command-centre.md", projectId: DEMO_PROJECTS[0].id } },
      // Claude Code's order: the edit is announced as the tool is called, then
      // waits on the approval, and is a fact only when the call finishes.
      { kind: "tool_started", summary: "Edit", tool: { name: "Edit", callId: "release-call-2" } },
      { kind: "file_modified", summary: "Edit CHANGELOG.md", file: { relativePath: "CHANGELOG.md", projectId: DEMO_PROJECTS[0].id } },
      {
        kind: "approval_requested",
        summary: "Edit CHANGELOG.md",
        approvalId: RELEASE_APPROVAL.approvalId,
        tool: { name: "Edit", callId: "release-call-2" },
      },
      { kind: "approval_granted", summary: "Approved", approvalId: RELEASE_APPROVAL.approvalId },
      { kind: "tool_finished", summary: "Edit", tool: { name: "Edit", callId: "release-call-2", ok: true } },
      {
        kind: "message_received",
        summary: "Reply",
        messageId: "release-m2",
        text: "Added a 0.9 section to CHANGELOG.md with the three changes from the Release checklist. Nothing else in the project changed.",
      },
      { kind: "run_completed", summary: "Run completed." },
    ],
    DEMO_NOW - 5 * HOUR - 10 * MIN
  ),
  [CODEX_AUTH_SESSION]: buildEvents(
    CODEX_AUTH_SESSION,
    "openai-codex",
    [
      { kind: "session_started", summary: "Session started." },
      {
        kind: "message_sent",
        summary: "Message sent.",
        messageId: "auth-m1",
        text: "Fix the authentication bug: sign-in accepts a wrong password.",
      },
      { kind: "file_read", summary: "Read src/app/api/auth/route.ts", file: { relativePath: "src/app/api/auth/route.ts", projectId: DEMO_PROJECT_ID } },
      { kind: "file_read", summary: "Read src/lib/session.ts", file: { relativePath: "src/lib/session.ts", projectId: DEMO_PROJECT_ID } },
      {
        kind: "message_received",
        summary: "Reply",
        messageId: "auth-m2",
        text: "verifyPassword is async and the route never awaits it, so every password passes. I'll await it, validate the body, and harden the session cookie.",
      },
      { kind: "approval_requested", summary: "Editing files", approvalId: AUTH_APPROVAL.approvalId },
    ],
    DEMO_NOW - 6 * MIN
  ),
}

export const DEMO_APPROVALS: Readonly<Record<string, readonly RuntimeApprovalView[]>> = {
  [CLAUDE_SESSION]: [SWE_APPROVAL],
  [CODEX_AUTH_SESSION]: [AUTH_APPROVAL],
}

// --------------------------------------------------------------- history

/*
 * Agent history: sessions that ended before the visitor arrived, as Hubble
 * keeps them (lib/agents/activity/history.ts). Each is written the way the
 * runtime writes one — the session's canonical events, its approvals and the
 * change the Command Centre applied, each through the product's own history
 * reducers — so what the demo opens is what Hubble reads back after a
 * restart, with the conversation's text already dropped.
 */

export const HISTORY_IDEAS_SESSION = "session-history-claude-ideas"
export const HISTORY_SCHOOL_SESSION = "session-history-gemini-school"
export const HISTORY_COURSES_SESSION = "session-history-codex-courses"
export const HISTORY_RELEASE_SESSION = "session-history-grok-release"
/** Codex, continuing "Group the product ideas" — a past explicit handoff (Hubble 1.4). */
export const HISTORY_ROADMAP_SESSION = "session-history-codex-roadmap"

export const HISTORY_IDEAS_APPROVAL: RuntimeApprovalView = {
  approvalId: "approval-history-ideas",
  sessionId: HISTORY_IDEAS_SESSION,
  provider: "claude-code",
  action: "change_workspace",
  scope: "write_workspace",
  workspaceId: RESEARCH_ID,
  targets: [`New collection "Product Ideas"`, "Linear", "Figma", "Hacker News"],
  reason: "Create a collection in this workspace.",
  change: { kind: "create_collection", subject: "Product Ideas", tabCount: 3, details: ["Linear", "Figma", "Hacker News"] },
  requestedAt: DEMO_NOW - DAY - 40 * MIN + 32_000,
  expiresAt: DEMO_NOW - DAY - 35 * MIN,
}

function historyDetail(
  session: Omit<AgentHistorySession, "startedAt" | "lastActivityAt" | "endedAt">,
  events: readonly SequencedControlEvent[],
  more: { approvals?: readonly RuntimeApprovalView[]; changes?: readonly AppliedWorkspaceChange[]; handoffs?: readonly SessionHandoff[] } = {}
): AgentHistoryDetail {
  const startedAt = events[0]!.timestamp
  const lastActivityAt = events[events.length - 1]!.timestamp
  // The relationship from the explicit handoff records, as the store reads it back.
  const handoff = handoffLinksOf(session.sessionId, more.handoffs ?? [])
  return {
    session: {
      ...session,
      startedAt,
      lastActivityAt,
      ...(session.status === "completed" || session.status === "failed" ? { endedAt: lastActivityAt } : {}),
      ...(handoff ? { handoff } : {}),
    },
    records: {
      events: events.map(historyEventOf).filter((event): event is SequencedControlEvent => event !== null),
      approvals: (more.approvals ?? []).map(historyApprovalOf),
      changes: (more.changes ?? []).map(historyChangeOf),
      undos: [],
      planOutcomes: [],
      ...(more.handoffs && more.handoffs.length > 0 ? { handoffs: more.handoffs } : {}),
    },
  }
}

const ideasEvents = buildEvents(
  HISTORY_IDEAS_SESSION,
  "claude-code",
  [
    { kind: "session_started", summary: "Session started." },
    // Research as it was then: "Product Ideas" is what this session made.
    {
      kind: "context_loaded",
      summary: contextCountsLine({ workspaceId: RESEARCH_ID, tabs: RESEARCH_TABS.length, collections: researchCollections().length - 1 }),
      context: { workspaceId: RESEARCH_ID, tabs: RESEARCH_TABS.length, collections: researchCollections().length - 1 },
    },
    { kind: "message_sent", summary: "Message sent.", messageId: "ideas-m1", text: "Group my product tabs in Research." },
    { kind: "tool_started", summary: "Reading Research", tool: contextTool("get_workspace_summary", "ideas-call-1") },
    contextRead(RESEARCH_ID, "get_workspace_summary", { tabs: RESEARCH_TABS.length, collections: researchCollections().length - 1 }),
    { kind: "tool_started", summary: "Searching for product tabs", tool: contextTool("search_tabs", "ideas-call-2") },
    contextRead(RESEARCH_ID, "search_tabs", { matches: productIdeas().tabIds.length }),
    { kind: "tool_started", summary: "Proposing “Product Ideas”", tool: contextTool("create_collection", "ideas-call-3") },
    { kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: HISTORY_IDEAS_APPROVAL.approvalId },
    { kind: "approval_granted", summary: "Workspace change approved", approvalId: HISTORY_IDEAS_APPROVAL.approvalId },
    { kind: "message_received", summary: "Reply", messageId: "ideas-m2", text: "“Product Ideas” now holds Linear, Figma and Hacker News." },
    { kind: "run_completed", summary: "Run completed." },
    // The person continued with Codex — the runtime's own words on the source.
    {
      kind: "handoff_sent",
      summary: "Handed off to Codex",
      handoff: {
        handoffId: "handoff-history-ideas",
        workspaceId: RESEARCH_ID,
        peerProvider: "openai-codex",
        peerSessionId: HISTORY_ROADMAP_SESSION,
        outcome: "ready",
      },
    },
  ],
  DEMO_NOW - DAY - 40 * MIN
)

/**
 * The past handoff, as the runtime recorded it: Claude Code's result in the
 * timeline's words, the workspace in counts, the person's instruction.
 * demo-parity.test.tsx checks the result line against what
 * `prepareHandoffPreview` derives from the session's own records.
 */
export const HISTORY_IDEAS_HANDOFF: SessionHandoff = {
  handoffId: "handoff-history-ideas",
  workspaceId: RESEARCH_ID,
  sourceSessionId: HISTORY_IDEAS_SESSION,
  sourceProvider: "claude-code",
  targetProvider: "openai-codex",
  targetSessionId: HISTORY_ROADMAP_SESSION,
  status: "ready",
  context: {
    workspace: { tabs: RESEARCH_TABS.length, collections: researchCollections().length },
    previousResult: { outcome: "finished", lines: [{ title: "Created collection “Product Ideas”", description: "3 tabs" }], more: 0 },
  },
  instruction: "Turn the product ideas into a short roadmap.",
  createdAt: ideasEvents[ideasEvents.length - 1]!.timestamp,
  updatedAt: ideasEvents[ideasEvents.length - 1]!.timestamp,
}

const roadmapReceived = {
  handoffId: HISTORY_IDEAS_HANDOFF.handoffId,
  workspaceId: RESEARCH_ID,
  peerProvider: "claude-code" as const,
  peerSessionId: HISTORY_IDEAS_SESSION,
}

const roadmapEvents = buildEvents(
  HISTORY_ROADMAP_SESSION,
  "openai-codex",
  [
    { kind: "session_started", summary: "Session started." },
    {
      kind: "message_sent",
      summary: "Handoff from Claude Code",
      handoff: roadmapReceived,
      text: buildHandoffEnvelope({
        workspaceName: "Research",
        sourceProvider: "claude-code",
        sourceTitle: "Group the product ideas",
        context: HISTORY_IDEAS_HANDOFF.context,
        contextTools: true,
        instruction: HISTORY_IDEAS_HANDOFF.instruction!,
      }),
    },
    { kind: "handoff_received", summary: "Handoff from Claude Code", handoff: roadmapReceived },
    contextLoaded(RESEARCH_ID),
    { kind: "tool_started", summary: "Reading Product Ideas", tool: contextTool("get_collection", "roadmap-call-1") },
    contextRead(RESEARCH_ID, "get_collection", { tabs: productIdeas().tabIds.length }),
    { kind: "message_received", summary: "Reply", messageId: "roadmap-m1", text: "Roadmap: Linear for planning, Figma for the board, Hacker News for launch." },
    { kind: "run_completed", summary: "Run completed." },
  ],
  HISTORY_IDEAS_HANDOFF.createdAt + 1_000
)

/* ---------------------------------------------------------------- the live handoff (Hubble 1.4) */

/**
 * What the demo's Codex does when a visitor continues Claude Code's work with
 * it: gathers the tabs an implementation would start from into a collection —
 * asking first, like every agent's workspace change.
 */
export const HANDOFF_PLAN = {
  name: "Implementation Plan",
  tabIds: ["t-swe-repo", "t-mcp", "t-acp"],
  titles: ["SWE-bench/SWE-bench", "Model Context Protocol", "Agent Client Protocol"],
  reply: "Done. “Implementation Plan” is in Research with the SWE-bench repository and the two protocol specs it builds on.",
} as const

/** Codex's request, as the broker would report it — the same shape as Claude Code's. */
export function handoffApproval(sessionId: string, approvalId: string, requestedAt: number): RuntimeApprovalView {
  return {
    approvalId,
    sessionId,
    provider: "openai-codex",
    action: "change_workspace",
    scope: "write_workspace",
    workspaceId: RESEARCH_ID,
    targets: [`New collection "${HANDOFF_PLAN.name}"`, ...HANDOFF_PLAN.titles],
    reason: "Create a collection in this workspace.",
    change: { kind: "create_collection", subject: HANDOFF_PLAN.name, tabCount: HANDOFF_PLAN.tabIds.length, details: [...HANDOFF_PLAN.titles] },
    requestedAt,
    expiresAt: requestedAt + 5 * MIN,
  }
}

/** A past session in Development (Hubble 1.6): a project change Hubble measured and checked, read-only now. */
export const HISTORY_EXPIRY_SESSION = "session-history-codex-expiry"

const EXPIRY_CHANGE = demoProjectChange({
  changeId: "approval-history-expiry",
  files: [{ path: "src/lib/session.test.ts", before: "", after: 'import { describe, it, expect } from "vitest"\n\ndescribe("readSession", () => {\n  it("refuses an expired session", () => {\n    expect(true).toBe(true)\n  })\n})\n' }],
})

/** A file the agent created: the measured change says so. */
const EXPIRY_CREATED = { ...EXPIRY_CHANGE, files: EXPIRY_CHANGE.files.map((file) => ({ ...file, change: "created" as const })) }

const expiryEvents = buildEvents(
  HISTORY_EXPIRY_SESSION,
  "openai-codex",
  [
    { kind: "session_started", summary: "Session started." },
    { kind: "message_sent", summary: "Message sent.", messageId: "expiry-m1", text: "Add a test that expired sessions are refused." },
    { kind: "approval_requested", summary: "Creating files", approvalId: "approval-history-expiry" },
    { kind: "approval_granted", summary: "Approved", approvalId: "approval-history-expiry" },
    { kind: "project_changed", summary: projectChangeTitle(EXPIRY_CREATED), projectChange: EXPIRY_CREATED },
    {
      kind: "verification_finished",
      summary: verificationTitle("test", "passed"),
      verification: { checkId: "check-history-expiry", projectId: DEMO_PROJECT_ID, check: "test", outcome: "passed", exitCode: 0, durationMs: 9_000, changeId: "approval-history-expiry" },
    },
    { kind: "run_completed", summary: "Run completed." },
  ],
  DEMO_NOW - DAY - 2 * HOUR
)

export const HISTORY_EXPIRY_APPROVAL: RuntimeApprovalView = {
  approvalId: "approval-history-expiry",
  sessionId: HISTORY_EXPIRY_SESSION,
  provider: "openai-codex",
  action: "create_files",
  scope: "write_project",
  projectId: DEMO_PROJECT_ID,
  targets: ["src/lib/session.test.ts"],
  requestedAt: expiryEvents[2]!.timestamp,
  expiresAt: expiryEvents[2]!.timestamp + 10 * MIN,
}

export const DEMO_HISTORY: readonly AgentHistoryDetail[] = [
  historyDetail(
    { sessionId: HISTORY_EXPIRY_SESSION, workspaceId: DEVELOPMENT_ID, provider: "openai-codex", status: "completed", title: "Test session expiry", projectId: DEMO_PROJECT_ID },
    expiryEvents,
    { approvals: [HISTORY_EXPIRY_APPROVAL] }
  ),
  historyDetail(
    { sessionId: HISTORY_IDEAS_SESSION, workspaceId: RESEARCH_ID, provider: "claude-code", status: "completed", title: "Group the product ideas" },
    ideasEvents,
    {
      approvals: [HISTORY_IDEAS_APPROVAL],
      handoffs: [HISTORY_IDEAS_HANDOFF],
      changes: [
        {
          id: "history-change-ideas",
          sessionId: HISTORY_IDEAS_SESSION,
          provider: "claude-code",
          workspaceId: RESEARCH_ID,
          // Applied once the approval came back, before the agent's reply.
          at: ideasEvents[9]!.timestamp + 500,
          ok: true,
          approvalId: HISTORY_IDEAS_APPROVAL.approvalId,
          steps: [{ kind: "created", collectionId: "c-product-ideas", name: "Product Ideas", tabCount: productIdeas().tabIds.length }],
          // Research's collections either side — the exact inverse an undo needs.
          before: researchCollections().filter((collection) => collection.id !== "c-product-ideas"),
          after: researchCollections(),
        },
      ],
    }
  ),
  historyDetail(
    { sessionId: HISTORY_ROADMAP_SESSION, workspaceId: RESEARCH_ID, provider: "openai-codex", status: "completed", title: "Turn the ideas into a roadmap" },
    roadmapEvents,
    { handoffs: [HISTORY_IDEAS_HANDOFF] }
  ),
  historyDetail(
    { sessionId: HISTORY_SCHOOL_SESSION, workspaceId: RESEARCH_ID, provider: "gemini", status: "failed", title: "Find themes in School" },
    buildEvents(
      HISTORY_SCHOOL_SESSION,
      "gemini",
      [
        { kind: "session_started", summary: "Session started." },
        contextLoaded(RESEARCH_ID),
        { kind: "message_sent", summary: "Message sent.", messageId: "school-m1", text: "What connects the School tabs?" },
        { kind: "tool_started", summary: "Reading School", tool: contextTool("get_collection", "school-call-1") },
        contextRead(RESEARCH_ID, "get_collection", { tabs: DEMO_COLLECTIONS.find((collection) => collection.id === "c-school")!.tabIds.length }),
        { kind: "error", summary: "Agent disconnected unexpectedly" },
      ],
      DEMO_NOW - 2 * DAY - 3 * HOUR
    )
  ),
  // Recorded while it worked; the runtime that drove it stopped. History says
  // "Disconnected", never "Running".
  historyDetail(
    { sessionId: HISTORY_COURSES_SESSION, workspaceId: RESEARCH_ID, provider: "openai-codex", status: "running", title: "Summarise the course pages" },
    buildEvents(
      HISTORY_COURSES_SESSION,
      "openai-codex",
      [
        { kind: "session_started", summary: "Session started." },
        contextLoaded(RESEARCH_ID),
        { kind: "message_sent", summary: "Message sent.", messageId: "courses-m1", text: "Summarise the course pages in Research." },
        { kind: "tool_started", summary: "Searching for courses", tool: contextTool("search_tabs", "courses-call-1") },
        contextRead(RESEARCH_ID, "search_tabs", { matches: 2 }),
      ],
      DEMO_NOW - 3 * DAY - 5 * HOUR
    )
  ),
  // Another workspace's: never listed while Research is on screen.
  historyDetail(
    { sessionId: HISTORY_RELEASE_SESSION, workspaceId: BUILD_ID, provider: "grok", status: "completed", title: "Check the release links" },
    buildEvents(
      HISTORY_RELEASE_SESSION,
      "grok",
      [
        { kind: "session_started", summary: "Session started." },
        contextLoaded(BUILD_ID),
        { kind: "tool_started", summary: "Reading Release checklist", tool: contextTool("get_collection", "links-call-1") },
        contextRead(BUILD_ID, "get_collection", { tabs: 3 }),
        { kind: "run_completed", summary: "Run completed." },
      ],
      DEMO_NOW - DAY - 6 * HOUR
    )
  ),
]
