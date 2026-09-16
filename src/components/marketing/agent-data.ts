import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index"
import { AGENT_STATE_VERSION } from "@/lib/agents/types"
import type {
  Agent,
  AgentEvent,
  AgentRun,
  AgentRunArtifactLink,
  AgentRunArtifactRole,
  AgentRunLink,
  AgentState,
  AgentWorkItem,
  WorkArtifact,
} from "@/lib/agents/types"
import { demoTabByTitle } from "./data"

/**
 * One fictional agent session, expressed in TabDump's own agent domain.
 *
 * ## Why this is typed against the real domain
 *
 * Every value below is an `Agent`, `AgentRun`, `AgentWorkItem`, `WorkArtifact`
 * or `AgentEvent` — the same types `src/lib/agents` persists — and the numbers
 * the page renders are produced by the product's own selectors
 * (`buildAgentDomainIndex`, `getAgentRunSummary`, `getWorkspaceActivityCards`,
 * `getHighlightedObjectIds`) rather than typed into the markup beside them.
 *
 * That costs a little more than a plain object literal and buys the one thing
 * a product page most often gets wrong: a demo that claims something the
 * product does not do. "2 of 5 items", "5 files", "3 context tabs" and the
 * highlight set behind Demo B are all *derived here the way they are derived
 * in the app*, so a change to the rules downstream shows up on this page as a
 * changed number instead of as a quiet lie. If the domain ever stops
 * supporting a shape this file describes, it stops type-checking.
 *
 * ## What it deliberately is not
 *
 * It is not connected to anything. Nothing here reads the agent store, the
 * Claude Code observation endpoint, persistence, or a visitor's filesystem —
 * the imports above are types and pure functions only. A visitor with no local
 * Claude Code installation (which is every visitor arriving from the web) sees
 * exactly what a visitor with one sees, because this is a fixture, not an
 * observation. Section 3 of the landing brief, made structural.
 */

/* -------------------------------------------------------------------------
 * Clock
 * ---------------------------------------------------------------------- */

/**
 * A fixed instant, in UTC, that the whole fixture hangs off.
 *
 * Not `Date.now()`, and the timestamps below are never relative to it. Two
 * reasons, both hard requirements rather than preferences: the landing page is
 * server-rendered at `/welcome`, so a wall-clock read would serialise one
 * value into the HTML and a different one on hydration; and a timeline that
 * reads "2 minutes ago" on a page nobody has updated since is a claim about
 * something that never happened.
 */
const DAY = Date.UTC(2026, 8, 15)

/** Minutes past midnight UTC on that day. */
function at(hours: number, minutes: number): number {
  return DAY + hours * 3_600_000 + minutes * 60_000
}

/**
 * Formats one of the timestamps above as `HH:MM`.
 *
 * Explicitly UTC. `toLocaleTimeString` would render in the *server's* zone
 * during SSR and the *visitor's* on hydration, which is a mismatch on every
 * timeline row for anyone outside UTC.
 */
export function demoClock(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}

/* -------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------- */

export const DEMO_WORKSPACE_ID = "ws-building-tabdump"
export const DEMO_WORKSPACE_NAME = "Building TabDump"
export const DEMO_RUN_ID = "run-auth"
export const DEMO_AGENT_ID = "agent-claude-code"

/** The project root the run reported. Relative paths below hang off it. */
const PROJECT_PATH = "~/code/tabdump"

const CLAUDE_CODE: Agent = {
  id: DEMO_AGENT_ID,
  // The one provider key TabDump actually observes today. See
  // src/lib/agents/claude-code — the adapter is read-only and local.
  provider: "claude-code",
  name: "Claude Code",
  createdAt: at(9, 38),
  updatedAt: at(9, 45),
}

/**
 * The run the page follows.
 *
 * `waiting` rather than `working` at rest: it is the more interesting of the
 * two live states and the one that makes the point of the whole page — an
 * agent that has stopped and is waiting on you is exactly the thing you cannot
 * see today. The hero animation walks a copy of this run from `working` to
 * here; Demo A lets a reader move it themselves.
 */
const RUN: AgentRun = {
  id: DEMO_RUN_ID,
  agentId: DEMO_AGENT_ID,
  workspaceId: DEMO_WORKSPACE_ID,
  externalId: "sess-8f2c",
  status: "waiting",
  title: "Implement account sign-in",
  currentActivity: "Waiting on the production OAuth client id",
  createdAt: at(9, 41),
  updatedAt: at(9, 45),
}

/* -------------------------------------------------------------------------
 * Work items
 *
 * Plan order, oldest first — the order the index returns them in, and the
 * order a plan is written in. Five items across four statuses, because a demo
 * that shows only "done" and "doing" would not show the two states the
 * product exists to surface: `blocked`, and work not yet started.
 * ---------------------------------------------------------------------- */

const WORK_ITEMS: AgentWorkItem[] = [
  {
    id: "wi-contract",
    workspaceId: DEMO_WORKSPACE_ID,
    runId: DEMO_RUN_ID,
    externalId: "task-1",
    title: "Define the session cookie contract",
    summary: "Signed, http-only, SameSite=Lax, seven-day expiry.",
    status: "completed",
    createdAt: at(9, 41),
    updatedAt: at(9, 43),
    startedAt: at(9, 41),
    completedAt: at(9, 43),
  },
  {
    id: "wi-google",
    workspaceId: DEMO_WORKSPACE_ID,
    runId: DEMO_RUN_ID,
    externalId: "task-2",
    title: "Wire Google sign-in to the auth route",
    summary: "Nonce, token exchange, and the callback the extension already expects.",
    status: "completed",
    createdAt: at(9, 41),
    updatedAt: at(9, 44),
    startedAt: at(9, 43),
    completedAt: at(9, 44),
  },
  {
    id: "wi-namespace",
    workspaceId: DEMO_WORKSPACE_ID,
    runId: DEMO_RUN_ID,
    externalId: "task-3",
    title: "Scope stored workspaces to the signed-in account",
    summary: "One storage namespace per account, so signing out cannot expose the last person's tabs.",
    status: "active",
    createdAt: at(9, 41),
    updatedAt: at(9, 45),
    startedAt: at(9, 44),
  },
  {
    id: "wi-oauth",
    workspaceId: DEMO_WORKSPACE_ID,
    runId: DEMO_RUN_ID,
    externalId: "task-4",
    title: "Point the callback at the production OAuth client",
    summary: "Needs the client id from the console — not something the agent can go and get.",
    status: "blocked",
    createdAt: at(9, 41),
    updatedAt: at(9, 45),
    startedAt: at(9, 45),
  },
  {
    id: "wi-tests",
    workspaceId: DEMO_WORKSPACE_ID,
    runId: DEMO_RUN_ID,
    externalId: "task-5",
    title: "Cover the logout path with tests",
    status: "pending",
    createdAt: at(9, 41),
    updatedAt: at(9, 41),
  },
]

/* -------------------------------------------------------------------------
 * Artifacts
 *
 * Project-relative paths, never absolute — the domain refuses an absolute path
 * (see src/lib/agents/paths.ts) and a landing page showing someone's home
 * directory would be the worst possible advertisement for a tool that reads
 * local sessions. `~/code/tabdump` is the fictional root; nothing below it is
 * a real file on anyone's machine.
 * ---------------------------------------------------------------------- */

type ArtifactSeed = { id: string; path: string; roles: AgentRunArtifactRole[]; at: number }

const ARTIFACT_SEEDS: ArtifactSeed[] = [
  { id: "af-session", path: "src/lib/auth/session.ts", roles: ["created", "edited"], at: at(9, 43) },
  { id: "af-route", path: "src/app/api/auth/google/route.ts", roles: ["edited"], at: at(9, 44) },
  { id: "af-provider", path: "src/components/auth/auth-provider.tsx", roles: ["edited"], at: at(9, 44) },
  { id: "af-namespace", path: "src/lib/storage/namespace.ts", roles: ["edited"], at: at(9, 45) },
  { id: "af-config", path: "src/lib/auth/config.ts", roles: ["inspected"], at: at(9, 45) },
]

const ARTIFACTS: WorkArtifact[] = ARTIFACT_SEEDS.map((seed) => ({
  id: seed.id,
  workspaceId: DEMO_WORKSPACE_ID,
  projectPath: PROJECT_PATH,
  relativePath: seed.path,
  kind: "file",
  createdAt: at(9, 42),
  updatedAt: seed.at,
}))

/**
 * One link per (run, file, role).
 *
 * A file can carry more than one role — `session.ts` below was created and
 * then edited — which is why `artifactCount` in the summary counts distinct
 * files rather than links. Flattening the roles into one "touched" would throw
 * away the distinction the artifact section is built on.
 */
const ARTIFACT_LINKS: AgentRunArtifactLink[] = ARTIFACT_SEEDS.flatMap((seed) =>
  seed.roles.map((role) => ({
    id: `arl-${seed.id}-${role}`,
    runId: DEMO_RUN_ID,
    artifactId: seed.id,
    role,
    createdAt: seed.at,
  }))
)

/* -------------------------------------------------------------------------
 * Tabs the run touched
 * ---------------------------------------------------------------------- */

/** Resolved from the shared corpus, so these rows are the same tabs the rest of the page organizes. */
export const DEMO_CONTEXT_TABS = [
  demoTabByTitle("Set-Cookie — HTTP"),
  demoTabByTitle("googleapis/google-auth-library-nodejs"),
  demoTabByTitle("SameSite cookies explained"),
]

export const DEMO_PRODUCED_TABS = [demoTabByTitle("tabdump/tabdump · Pull requests")]

const TAB_LINKS: AgentRunLink[] = [
  ...DEMO_CONTEXT_TABS.map((t, i) => ({
    id: `arl-ctx-${t.id}`,
    runId: DEMO_RUN_ID,
    tabId: t.id,
    role: "context" as const,
    createdAt: at(9, 41) + i * 1000,
  })),
  ...DEMO_PRODUCED_TABS.map((t) => ({
    id: `arl-out-${t.id}`,
    runId: DEMO_RUN_ID,
    tabId: t.id,
    role: "produced" as const,
    createdAt: at(9, 44),
  })),
]

/* -------------------------------------------------------------------------
 * Events
 *
 * The run's activity log, in the closed `AgentEventKind` vocabulary. Summaries
 * are short, already-safe lines — "Edited session.ts", never a command, a
 * prompt or a tool result. There is no field here for any of those, which is
 * the structural reason the timeline on this page cannot show one.
 * ---------------------------------------------------------------------- */

const EVENTS: AgentEvent[] = [
  { id: "ev-1", runId: DEMO_RUN_ID, timestamp: at(9, 41), kind: "started", summary: "Started working in Building TabDump" },
  { id: "ev-2", runId: DEMO_RUN_ID, timestamp: at(9, 42), kind: "link", summary: "Picked up 3 open tabs as context" },
  { id: "ev-3", runId: DEMO_RUN_ID, timestamp: at(9, 43), kind: "activity", summary: "Created src/lib/auth/session.ts" },
  { id: "ev-4", runId: DEMO_RUN_ID, timestamp: at(9, 44), kind: "activity", summary: "Completed: Wire Google sign-in to the auth route" },
  { id: "ev-5", runId: DEMO_RUN_ID, timestamp: at(9, 45), kind: "status", summary: "Waiting on the production OAuth client id" },
]


/* -------------------------------------------------------------------------
 * A second run
 *
 * Earlier the same morning, finished, and touching a different part of the
 * project. It exists so that "what does this run touch?" has a visible answer:
 * with one run in the workspace, selecting it highlights everything and the
 * question looks rhetorical. With two, the highlight is a genuine subset — which
 * is the claim the impact section actually makes.
 *
 * Same agent, a different run. That pairing is the domain's central modelling
 * decision (one persistent Agent, many AgentRuns), and showing it is worth more
 * than inventing a second agent identity would be.
 * ---------------------------------------------------------------------- */

export const DEMO_PRIOR_RUN_ID = "run-dedupe"

const PRIOR_RUN: AgentRun = {
  id: DEMO_PRIOR_RUN_ID,
  agentId: DEMO_AGENT_ID,
  workspaceId: DEMO_WORKSPACE_ID,
  externalId: "sess-4a19",
  status: "completed",
  title: "Fix the duplicate-tab merge",
  createdAt: at(8, 52),
  updatedAt: at(9, 26),
  endedAt: at(9, 26),
}

const PRIOR_WORK_ITEMS: AgentWorkItem[] = [
  {
    id: "wi-dedupe-key",
    workspaceId: DEMO_WORKSPACE_ID,
    runId: DEMO_PRIOR_RUN_ID,
    externalId: "task-1",
    title: "Normalise the URL before comparing",
    status: "completed",
    createdAt: at(8, 52),
    updatedAt: at(9, 14),
    startedAt: at(8, 53),
    completedAt: at(9, 14),
  },
  {
    id: "wi-dedupe-tests",
    workspaceId: DEMO_WORKSPACE_ID,
    runId: DEMO_PRIOR_RUN_ID,
    externalId: "task-2",
    title: "Cover the tracking-parameter cases",
    status: "completed",
    createdAt: at(8, 52),
    updatedAt: at(9, 26),
    startedAt: at(9, 14),
    completedAt: at(9, 26),
  },
]

const PRIOR_ARTIFACT_SEEDS: ArtifactSeed[] = [
  { id: "af-dedupe", path: "src/lib/workspace/dedupe.ts", roles: ["edited"], at: at(9, 14) },
  { id: "af-dedupe-test", path: "src/lib/workspace/dedupe.test.ts", roles: ["created"], at: at(9, 26) },
]

const PRIOR_ARTIFACTS: WorkArtifact[] = PRIOR_ARTIFACT_SEEDS.map((seed) => ({
  id: seed.id,
  workspaceId: DEMO_WORKSPACE_ID,
  projectPath: PROJECT_PATH,
  relativePath: seed.path,
  kind: "file",
  createdAt: at(8, 55),
  updatedAt: seed.at,
}))

const PRIOR_ARTIFACT_LINKS: AgentRunArtifactLink[] = PRIOR_ARTIFACT_SEEDS.flatMap((seed) =>
  seed.roles.map((role) => ({
    id: `arl-${seed.id}-${role}`,
    runId: DEMO_PRIOR_RUN_ID,
    artifactId: seed.id,
    role,
    createdAt: seed.at,
  }))
)

/** The prior run's context: the issue thread it was working from. */
export const DEMO_PRIOR_CONTEXT_TABS = [demoTabByTitle("vercel/next.js · Issues")]

const PRIOR_TAB_LINKS: AgentRunLink[] = DEMO_PRIOR_CONTEXT_TABS.map((t) => ({
  id: `arl-prior-ctx-${t.id}`,
  runId: DEMO_PRIOR_RUN_ID,
  tabId: t.id,
  role: "context" as const,
  createdAt: at(8, 53),
}))

const PRIOR_EVENTS: AgentEvent[] = [
  { id: "pev-1", runId: DEMO_PRIOR_RUN_ID, timestamp: at(8, 52), kind: "started", summary: "Started working in Building TabDump" },
  { id: "pev-2", runId: DEMO_PRIOR_RUN_ID, timestamp: at(9, 14), kind: "activity", summary: "Edited src/lib/workspace/dedupe.ts" },
  { id: "pev-3", runId: DEMO_PRIOR_RUN_ID, timestamp: at(9, 26), kind: "ended", summary: "Finished: 2 of 2 work items complete" },
]

/** Both runs' files, newest run first — what the workspace holds, not what one run touched. */
export const DEMO_ALL_ARTIFACT_SEEDS = [...ARTIFACT_SEEDS, ...PRIOR_ARTIFACT_SEEDS]

/** Every work item in the workspace, across both runs. */
export const DEMO_ALL_WORK_ITEMS = [...WORK_ITEMS, ...PRIOR_WORK_ITEMS]
/* -------------------------------------------------------------------------
 * The assembled domain
 * ---------------------------------------------------------------------- */

/** A complete, valid `AgentState` — the same shape the app persists. */
export const DEMO_AGENT_STATE: AgentState = {
  version: AGENT_STATE_VERSION,
  // One agent, two runs — the domain's central modelling decision, shown rather
  // than described. Newest run first, matching the order the index groups them in.
  agents: [CLAUDE_CODE],
  runs: [RUN, PRIOR_RUN],
  links: [...TAB_LINKS, ...PRIOR_TAB_LINKS],
  events: [...EVENTS, ...PRIOR_EVENTS],
  artifacts: [...ARTIFACTS, ...PRIOR_ARTIFACTS],
  artifactLinks: [...ARTIFACT_LINKS, ...PRIOR_ARTIFACT_LINKS],
  workItems: [...WORK_ITEMS, ...PRIOR_WORK_ITEMS],
}

/**
 * Built once at module scope.
 *
 * The index is a pure function of the state and the state is a frozen fixture,
 * so there is exactly one right answer and no reason for a component to
 * rebuild it — or to memoise it per mount. Every agent demo on the page reads
 * from this one index, which is also what keeps them agreeing with each other.
 */
export const DEMO_AGENT_INDEX = buildAgentDomainIndex(DEMO_AGENT_STATE)

/** The fixture's work items in plan order, for demos that render the list directly. */
export const DEMO_WORK_ITEMS = WORK_ITEMS

/** The fixture's events, oldest first — the order the timeline plays them in. */
export const DEMO_EVENTS = EVENTS

/** Artifact id → the roles this run holds on it, for the file section. */
export const DEMO_ARTIFACT_SEEDS = ARTIFACT_SEEDS

/* -------------------------------------------------------------------------
 * Providers
 * ---------------------------------------------------------------------- */

/**
 * What TabDump observes, and what it does not yet.
 *
 * The `status` field exists so the provider section cannot be written in a way
 * that blurs the two. The agent domain is provider-neutral by construction —
 * `Agent.provider` is an opaque string the domain never interprets — but
 * exactly one adapter exists today, and a landing page implying otherwise
 * would be claiming an integration that is not there.
 */
export type DemoProvider = {
  id: string
  name: string
  status: "supported" | "planned"
  /** One line on what observing this provider means, or would mean. */
  note: string
}

export const DEMO_PROVIDERS: DemoProvider[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    status: "supported",
    note: "Read locally, from sessions already on your machine.",
  },
  { id: "codex", name: "Codex", status: "planned", note: "No adapter yet." },
  { id: "gemini", name: "Gemini CLI", status: "planned", note: "No adapter yet." },
  { id: "grok", name: "Grok", status: "planned", note: "No adapter yet." },
]
