import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentIdentity } from "@/lib/agents/platform/roster"
import type { RuntimeApprovalView, RuntimeSessionContextView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import type { Collection } from "@/lib/collections/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Section } from "@/lib/sections/types"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

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

export const DEMO_WORKSPACES: readonly Workspace[] = [
  workspace(RESEARCH_ID, "Research", RESEARCH_TABS, RESEARCH_SECTIONS),
  workspace(BUILD_ID, "Hubble Build", BUILD_TABS, BUILD_SECTIONS),
  workspace(SEMESTER_ID, "Semester", SEMESTER_TABS, SEMESTER_SECTIONS),
]

// --------------------------------------------------------- collections

function collection(id: string, workspaceId: string, name: string, tabIds: string[]): Collection {
  return { id, workspaceId, name, tabIds, createdAt: DEMO_NOW - 2 * DAY, updatedAt: DEMO_NOW - 2 * DAY }
}

export const DEMO_COLLECTIONS: readonly Collection[] = [
  collection("c-ai-research", RESEARCH_ID, "AI Research", ["t-attention", "t-react", "t-toolformer", "t-claude-code"]),
  collection("c-product-ideas", RESEARCH_ID, "Product Ideas", ["t-linear", "t-figma", "t-hn"]),
  collection("c-hubble", RESEARCH_ID, "Hubble", ["t-hubble-docs", "t-hubble-context", "t-mcp", "t-acp"]),
  collection("c-school", RESEARCH_ID, "School", ["t-ocw", "t-khan"]),
  collection("c-release", BUILD_ID, "Release checklist", ["b-next", "b-vercel", "b-changelog"]),
  collection("c-essay", SEMESTER_ID, "Essay sources", ["m-scholar", "m-zotero"]),
]

export const DEMO_DEPENDENCIES: readonly TabDependency[] = [
  { id: "d-board-paper", parentTabId: "t-swe-board", childTabId: "t-swe-paper", type: "research", createdAt: DEMO_NOW - DAY },
  { id: "d-repo-paper", parentTabId: "t-swe-repo", childTabId: "t-swe-paper", type: "reference", createdAt: DEMO_NOW - DAY },
  { id: "d-context-mcp", parentTabId: "t-hubble-context", childTabId: "t-mcp", type: "reference", createdAt: DEMO_NOW - DAY },
]

// --------------------------------------------------------------- agents

/**
 * Connected agents, as the roster keeps them. Codex is connected but, exactly
 * as in the product, Hubble does not start sessions with it — its adapter has
 * no approval mode — so the roster says so and it has no session below.
 */
export const DEMO_AGENTS: readonly AgentIdentity[] = (
  [
    ["claude-code", "Claude Code", RESEARCH_ID],
    ["gemini", "Gemini CLI", RESEARCH_ID],
    ["grok", "Grok Build", BUILD_ID],
    ["openai-codex", "Codex", undefined],
  ] as const
).map(([provider, name, workspaceId]) => ({
  id: `agent:${provider}`,
  provider,
  name,
  connectedAt: DEMO_NOW - 5 * DAY,
  approvedScopes: ["read_workspace", "read_project", "write_project", "mcp_tools"],
  approvedAt: DEMO_NOW - 5 * DAY,
  ...(workspaceId ? { workspaceId } : {}),
}))

/** Who Hubble will start sessions with — the catalog's own answer, restated for the demo's roster. */
export const DEMO_SESSION_PROVIDERS: ReadonlySet<AgentProviderId> = new Set(["claude-code", "gemini", "grok"])

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

export const DEMO_PROJECTS = [{ id: "project-hubble-web", name: "hubble-web" }] as const

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
  }),
]

// --------------------------------------------------------------- events

/** Hubble's context tools as Claude Code names them: the minted server shape the Command Centre recognises. */
export function contextTool(name: string) {
  return { name: `mcp__tabdump_hubbledemosessio__${name}` }
}

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

export const SWE_APPROVAL: RuntimeApprovalView = {
  approvalId: "approval-swe-collection",
  sessionId: CLAUDE_SESSION,
  provider: "claude-code",
  action: "change_workspace",
  scope: "collections.write",
  workspaceId: RESEARCH_ID,
  targets: [],
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

export const DEMO_EVENTS: Readonly<Record<string, readonly SequencedControlEvent[]>> = {
  [CLAUDE_SESSION]: buildEvents(
    CLAUDE_SESSION,
    "claude-code",
    [
      { kind: "session_started", summary: "Session started." },
      {
        kind: "message_sent",
        summary: "Message sent.",
        messageId: "claude-m1",
        text: "Read the SWE-bench tabs in Research and tell me what each one is. If they belong together, put them in a collection.",
      },
      { kind: "thinking", summary: "Planning the summary" },
      { kind: "tool_started", summary: "Reading Research", tool: contextTool("get_workspace_summary") },
      { kind: "tool_started", summary: "Searching for SWE-bench", tool: contextTool("search_tabs") },
      { kind: "tool_started", summary: "Checking existing collections", tool: contextTool("find_relevant_collections") },
      {
        kind: "message_received",
        summary: "Reply",
        messageId: "claude-m2",
        text:
          "Three tabs are about SWE-bench: the paper that introduced it, its public leaderboard, and the benchmark's repository. None of your collections covers them yet.\n\nI'd like to group them into a new collection, “SWE-bench”.",
      },
      { kind: "tool_started", summary: "Proposing “SWE-bench”", tool: contextTool("create_collection") },
      { kind: "approval_requested", summary: "Create collection “SWE-bench”", approvalId: SWE_APPROVAL.approvalId },
    ],
    DEMO_NOW - 3 * MIN
  ),
  [GEMINI_SESSION]: buildEvents(
    GEMINI_SESSION,
    "gemini",
    [
      { kind: "session_started", summary: "Session started." },
      {
        kind: "message_sent",
        summary: "Message sent.",
        messageId: "gemini-m1",
        text: "Look at Product Ideas and suggest themes. Don't change anything yet.",
      },
      { kind: "tool_started", summary: "Reading Product Ideas", tool: contextTool("get_collection") },
      { kind: "tool_started", summary: "Grouping tabs by topic", tool: contextTool("analyze_topics") },
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
      { kind: "message_sent", summary: "Message sent.", messageId: "grok-m1", text: "Are there duplicate tabs in Hubble Build?" },
      { kind: "tool_started", summary: "Looking for duplicates", tool: contextTool("find_duplicate_tabs") },
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
      {
        kind: "message_sent",
        summary: "Message sent.",
        messageId: "release-m1",
        text: "Draft release notes for 0.9 from the Release checklist collection and the changelog in the project.",
      },
      { kind: "tool_started", summary: "Reading Release checklist", tool: contextTool("get_collection") },
      { kind: "file_read", summary: "Read CHANGELOG.md", file: { relativePath: "CHANGELOG.md", projectId: DEMO_PROJECTS[0].id } },
      { kind: "file_read", summary: "Read docs/command-centre.md", file: { relativePath: "docs/command-centre.md", projectId: DEMO_PROJECTS[0].id } },
      { kind: "approval_requested", summary: "Edit CHANGELOG.md", approvalId: "approval-release-edit" },
      { kind: "approval_granted", summary: "Edit CHANGELOG.md", approvalId: "approval-release-edit" },
      { kind: "file_modified", summary: "Updated CHANGELOG.md", file: { relativePath: "CHANGELOG.md", projectId: DEMO_PROJECTS[0].id } },
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
}

export const DEMO_APPROVALS: Readonly<Record<string, readonly RuntimeApprovalView[]>> = {
  [CLAUDE_SESSION]: [SWE_APPROVAL],
}
