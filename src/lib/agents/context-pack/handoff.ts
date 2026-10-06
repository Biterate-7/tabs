import { emptyContextWorld } from "@/lib/agents/context/world";
import { buildContextPack } from "./pack";
import type { AgentContextWorld } from "@/lib/agents/context/world";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { SessionFocus } from "@/lib/agents/session-context/focus";
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot";
import type { ContextPack } from "./pack";
import type { ProjectDescriptor } from "@/lib/agents/project/describe";

/**
 * The Context Pack a handoff passes (Hubble 1.5) — built by the same
 * constructor as every other pack, from the same three things on both sides:
 * the workspace, the source session's focus, and the modes the person kept.
 *
 *   - The runtime host builds it from the workspace copy it holds for the
 *     source session (`contextWorldOfSnapshot`), and sends its resources with
 *     the target's first message.
 *   - The handoff dialog builds it from the Command Centre's live world, to
 *     show the person what will be passed.
 *
 * Recent changes are left out on purpose: the previous result already says
 * what the source session changed, and the host does not hold anyone else's.
 */
export function handoffContextPack(input: {
  world: AgentContextWorld;
  workspaceId: string;
  /** The source session's focus, as the runtime holds it. Absent: the whole workspace. */
  focus?: SessionFocus;
  /** The modes the person kept (`selectHandoffContext`), or everything the preview offered. */
  context: SessionHandoff["context"];
  instruction?: string;
  /**
   * The project the target session works in (Hubble 1.6), described for the
   * target agent: its capabilities are the target's own, never the source's.
   */
  project?: ProjectDescriptor;
}): ContextPack | undefined {
  const share = Boolean(input.context.workspace);
  const result = buildContextPack({
    world: input.world,
    selection: {
      workspaceId: input.workspaceId,
      tabIds: share ? (input.focus?.tabIds ?? []) : [],
      collectionIds: share ? (input.focus?.collectionIds ?? []) : [],
    },
    ...(input.context.previousResult
      ? { previousResult: input.context.previousResult, files: input.context.previousResult.files ?? [] }
      : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.instruction ? { instruction: input.instruction } : {}),
  });
  return result.ok ? result.pack : undefined;
}

/** The world a runtime's workspace copy describes: that one workspace, nothing else. */
export function contextWorldOfSnapshot(snapshot: SessionContextSnapshot): AgentContextWorld {
  return {
    ...emptyContextWorld(null),
    workspaces: [snapshot.workspace],
    collections: snapshot.collections,
    dependencies: snapshot.dependencies,
  };
}
