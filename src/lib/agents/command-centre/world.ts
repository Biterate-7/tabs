import { emptyContextWorld } from "@/lib/agents/context/world"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { AgentProject } from "@/lib/agents/control/projects"
import type { Agent, AgentRun } from "@/lib/agents/types"
import type { Collection } from "@/lib/collections/types"
import type { ManualConnection } from "@/lib/graph/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Assembles the world the context resolver reads.
 *
 * ## Why this is a function and not an effect
 *
 * `AgentContextWorld` is a *view* of data the app already holds — workspaces,
 * collections, relationships, projects, agents, runs. It is not a store, it is
 * never persisted, and it must never be the place a piece of TabDump data
 * lives. Building it in one pure call, from values the shell is already
 * rendering, keeps it that way: there is no second copy to fall out of date
 * and nothing to invalidate.
 *
 * ## The owner is passed, never sniffed
 *
 * `ownerId` is the account the data was loaded under, and the resolver refuses
 * a request whose scope disagrees with it. That check is only worth anything if
 * the id genuinely comes from the same place the data did — so it is a
 * parameter, taken from the storage namespace the stores themselves were read
 * through, rather than something this function looks up on its own.
 *
 * `null` means signed out, which is a real account boundary: signed-out content
 * must not resolve into a signed-in session.
 */
export function buildContextWorld(input: {
  ownerId: string | null
  workspaces: readonly Workspace[]
  collections: readonly Collection[]
  dependencies: readonly TabDependency[]
  manualConnections: readonly ManualConnection[]
  projects: readonly AgentProject[]
  agents: readonly Agent[]
  runs: readonly AgentRun[]
}): AgentContextWorld {
  return {
    ...emptyContextWorld(input.ownerId),
    workspaces: input.workspaces,
    collections: input.collections,
    dependencies: input.dependencies,
    manualConnections: input.manualConnections,
    projects: input.projects,
    agents: input.agents,
    runs: input.runs,
  }
}
