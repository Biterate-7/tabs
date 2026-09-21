import type { AgentRunArtifactRole, AgentRunStatus, AgentWorkItemStatus } from "@/lib/agents/types"

/**
 * The words History and the Session View put on domain values.
 *
 * Shared so the two surfaces cannot drift: a run that says "Completed" in
 * the list must not say "Finished" once opened. Each map is exhaustive over
 * its union, so adding a status to the domain is a type error here rather
 * than a blank cell at runtime.
 */

/**
 * A run's status, in the domain's own vocabulary.
 *
 * Distinct from the work-item words below, and that distinction is
 * load-bearing: `blocked` is terminal for a run and not for a work item, so
 * "Blocked" means "this session stopped" in one column and "this task is
 * waiting on something" in the other. See the domain notes on
 * TERMINAL_AGENT_RUN_STATUSES.
 */
/**
 * A duration, in the coarsest unit that still says something useful.
 *
 * Returns null rather than a string for a nonsensical input (negative, NaN,
 * infinite), so a caller renders nothing instead of "NaN min". It moved here
 * when the Agent World was removed: it was always presentation vocabulary
 * rather than world geometry, and History and the Session View were already
 * its only consumers.
 */
export function formatElapsed(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return "under a minute"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ${minutes % 60} min`
  return `${Math.floor(hours / 24)} days`
}

export const RUN_STATUS_WORDS: Record<AgentRunStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
}

export const WORK_ITEM_STATUS_WORDS: Record<AgentWorkItemStatus, string> = {
  pending: "Pending",
  active: "Active",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
}

/**
 * How a run touched a file.
 *
 * The four stay distinct wherever they are rendered. An inspected file is
 * not a result, and collapsing "Read" into "Edited" would turn looking at
 * something into having changed it - the exact conflation the artifact role
 * vocabulary exists to prevent.
 */
export const ARTIFACT_ROLE_WORDS: Record<AgentRunArtifactRole, string> = {
  inspected: "Read",
  edited: "Edited",
  created: "Created",
  deleted: "Deleted",
}

/**
 * Roles that mean the run actually produced something.
 *
 * `inspected` is absent, and that is the whole point: a file the agent only
 * read is not a result of the work, and counting it as one would let a
 * session that changed nothing claim output.
 */
const PRODUCING_ROLES: readonly AgentRunArtifactRole[] = ["edited", "created", "deleted"]

export function isProducedRole(role: AgentRunArtifactRole): boolean {
  return PRODUCING_ROLES.includes(role)
}

/**
 * A stored timestamp as "2 hr 5 min ago".
 *
 * Built on `formatElapsed`, which the world already uses, so the two
 * surfaces round the same way and no second convention appears. Returns null
 * for a timestamp in the future rather than saying "in a while": the clock
 * here is the caller's `now`, and a record ahead of it is a clock
 * disagreement, not a prediction worth rendering.
 */
export function formatTimeAgo(timestamp: number, now: number): string | null {
  const elapsed = formatElapsed(now - timestamp)
  return elapsed === null ? null : `${elapsed} ago`
}

/**
 * The line shown where a run recorded no title.
 *
 * One sentence, stated once, so every surface says the same thing - and it
 * reads as a fact about the record rather than as a name the run might have
 * had. Nothing composes a title from a provider name and a date.
 */
export const NO_RUN_TITLE = "Session with no recorded work description"
