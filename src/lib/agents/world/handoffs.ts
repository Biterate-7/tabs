import type {
  AgentRunArtifactLink,
  AgentRunLink,
  WorkArtifact,
} from "@/lib/agents/types";

/**
 * When one agent's work reached another's.
 *
 * This module is the answer to the most tempting shortcut in the whole phase.
 * The brief asks for agent-to-agent communication to be visualised, and the
 * easy version — draw a line between any two agents that are on screen, send
 * a dot along it — would look exactly right and mean nothing. TabDump has no
 * agent-to-agent message: nothing it observes is one agent talking to
 * another, and a line drawn on that basis would be the app inventing a
 * relationship and animating it.
 *
 * What the domain *does* already record is real, directional, and enough:
 *
 *   1. **A shared file.** Two runs both touched the same `WorkArtifact`. The
 *      run that touched it first put something there; the run that touched it
 *      second found it. That is a transfer of work, and it is recorded in
 *      `AgentRunArtifactLink` with timestamps that say which way round.
 *   2. **A passed tab.** One run `produced` a tab and another used the same
 *      tab as `context`. This one is unambiguous — the roles are literally
 *      named "this run made it" and "this run read it".
 *
 * A workspace where neither happened produces no handoffs and the world draws
 * no lines, which for one agent working alone is the correct picture.
 *
 * ## Why chains, not pairs
 *
 * Six runs that all touched `package.json` have fifteen pairs between them.
 * Drawing all fifteen would bury the picture under a file every project
 * touches. So each artifact contributes a **chain**: sort its touches by
 * time and connect consecutive ones. Six runs give five edges, each of which
 * is the specific claim "this run picked the file up after that one" rather
 * than the vague claim "these two both touched it".
 */

/** One observed transfer, before it is attached to characters. */
export type DerivedHandoff = {
  fromRunId: string;
  toRunId: string;
  via: "file" | "tab";
  /** Short, already-safe: a project-relative path or a tab title. Never a raw provider string. */
  label: string;
  /** When the receiving side happened. Used to keep the most recent when capping. */
  at: number;
};

export type HandoffInput = {
  /** The runs currently on stage. Nothing outside this set can appear in a handoff. */
  visibleRunIds: readonly string[];
  artifacts: readonly WorkArtifact[];
  artifactLinks: readonly AgentRunArtifactLink[];
  runLinks: readonly AgentRunLink[];
  /** Tab id → title, so a passed tab can be named. Absent titles fall back to a generic phrase. */
  tabTitles?: ReadonlyMap<string, string>;
  /**
   * Upper bound on how many are returned.
   *
   * A hard cap rather than a scroll: the world is a picture, and past about a
   * dozen connections it stops being one. The most recent survive, because a
   * transfer that happened a moment ago is the one a person is watching for.
   */
  maxHandoffs?: number;
};

export const DEFAULT_MAX_HANDOFFS = 12;

/**
 * Every transfer between visible runs, most recent first.
 *
 * Pure, and derived entirely from links the caller already holds. A run id
 * that is not in `visibleRunIds` cannot appear on either end: the world never
 * draws a line to something it is not also drawing.
 */
export function deriveHandoffs(input: HandoffInput): DerivedHandoff[] {
  const {
    visibleRunIds,
    artifacts,
    artifactLinks,
    runLinks,
    tabTitles,
    maxHandoffs = DEFAULT_MAX_HANDOFFS,
  } = input;

  const visible = new Set(visibleRunIds);
  if (visible.size < 2) return [];

  const handoffs: DerivedHandoff[] = [];

  // ---- 1. Files two runs both worked on -----------------------------------

  const pathByArtifactId = new Map<string, string>();
  for (const artifact of artifacts) pathByArtifactId.set(artifact.id, artifact.relativePath);

  const touchesByArtifact = new Map<string, { runId: string; at: number }[]>();
  for (const link of artifactLinks) {
    if (!visible.has(link.runId)) continue;
    const bucket = touchesByArtifact.get(link.artifactId);
    if (bucket) bucket.push({ runId: link.runId, at: link.createdAt });
    else touchesByArtifact.set(link.artifactId, [{ runId: link.runId, at: link.createdAt }]);
  }

  for (const [artifactId, touches] of touchesByArtifact) {
    if (touches.length < 2) continue;

    // One entry per run: a run that inspected and then edited the same file
    // touched it twice, and that is one participant, not two. Earliest touch
    // wins, because that is when this run joined the chain.
    const earliest = new Map<string, number>();
    for (const touch of touches) {
      const current = earliest.get(touch.runId);
      if (current === undefined || touch.at < current) earliest.set(touch.runId, touch.at);
    }
    if (earliest.size < 2) continue;

    const ordered = [...earliest.entries()]
      .map(([runId, at]) => ({ runId, at }))
      // Ties broken by run id so the chain is deterministic — two runs that
      // touched a file in the same millisecond must not swap places between
      // renders.
      .sort((a, b) => a.at - b.at || (a.runId < b.runId ? -1 : 1));

    const label = pathByArtifactId.get(artifactId);
    for (let i = 1; i < ordered.length; i += 1) {
      handoffs.push({
        fromRunId: ordered[i - 1].runId,
        toRunId: ordered[i].runId,
        via: "file",
        // A path we could not resolve still describes a real transfer, so the
        // handoff survives with a generic label rather than being dropped.
        label: label ? `shared ${label}` : "shared a file",
        at: ordered[i].at,
      });
    }
  }

  // ---- 2. Tabs one run produced and another read --------------------------

  const producedByTab = new Map<string, { runId: string; at: number }[]>();
  const contextByTab = new Map<string, { runId: string; at: number }[]>();

  for (const link of runLinks) {
    if (!visible.has(link.runId)) continue;
    const target = link.role === "produced" ? producedByTab : contextByTab;
    const bucket = target.get(link.tabId);
    if (bucket) bucket.push({ runId: link.runId, at: link.createdAt });
    else target.set(link.tabId, [{ runId: link.runId, at: link.createdAt }]);
  }

  for (const [tabId, producers] of producedByTab) {
    const consumers = contextByTab.get(tabId);
    if (!consumers?.length) continue;

    const title = tabTitles?.get(tabId);
    const label = title ? `passed ${title}` : "passed a tab";

    for (const producer of producers) {
      for (const consumer of consumers) {
        // A run that both produced and read the same tab is not handing
        // anything to itself.
        if (producer.runId === consumer.runId) continue;
        // The direction is in the roles, but the ordering still has to hold:
        // a tab read before it was produced is not a transfer, it is two
        // runs that happened to touch the same page.
        if (consumer.at < producer.at) continue;

        handoffs.push({
          fromRunId: producer.runId,
          toRunId: consumer.runId,
          via: "tab",
          label,
          at: consumer.at,
        });
      }
    }
  }

  // ---- Fold ---------------------------------------------------------------

  // One edge per ordered pair. A pair that shows up through both a file and a
  // tab keeps the most recent evidence, because that is the transfer someone
  // watching would have just seen.
  const byPair = new Map<string, DerivedHandoff>();
  for (const handoff of handoffs) {
    const key = `${handoff.fromRunId}->${handoff.toRunId}`;
    const existing = byPair.get(key);
    if (!existing || handoff.at > existing.at) byPair.set(key, handoff);
  }

  return [...byPair.values()]
    .sort((a, b) => b.at - a.at || (a.fromRunId < b.fromRunId ? -1 : 1))
    .slice(0, maxHandoffs);
}

/**
 * There is deliberately no `runIdsInHandoffs` helper here.
 *
 * An earlier draft had one — "every run on either end of a handoff" — for
 * deciding who is `communicating`. It was removed because that is not the
 * question: `scene.ts` needs the runs whose handoff has **both ends live**,
 * which is a narrower set and the whole reason the state is self-limiting. A
 * helper answering the looser question, sitting next to the code that needs
 * the tighter one, is an invitation to reach for the wrong one.
 */
