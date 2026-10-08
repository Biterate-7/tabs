import { sourceCounts } from "@/lib/resources/ingest";
import { agentDisplayName } from "@/lib/agents/visual/identity";
import type { LastTask } from "@/lib/agents/command-centre/last-task";
import type { Workspace } from "@/lib/workspace/types";
import type { ProjectEvent } from "./activity";

/**
 * Where a project stands, and the one next step that follows from it.
 *
 * Every line is derived from records Hubble holds — the project's sources and
 * their status, its last agent task and its history — never generated or
 * guessed. When nothing follows from the state, there is no suggestion: an
 * empty slot is better than advice the product cannot back.
 */

export type NextStep =
  | { kind: "add_sources"; text: string }
  | { kind: "fix_sources"; text: string; count: number }
  | { kind: "first_task"; text: string }
  | { kind: "answer_agent"; text: string; sessionId: string }
  | { kind: "review_result"; text: string; sessionId: string }
  | { kind: "continue_with_another"; text: string; sessionId: string }
  | { kind: "retry_task"; text: string; sessionId: string };

export type ProjectState = {
  sources: ReturnType<typeof sourceCounts>;
  /** Tasks recorded in this project. */
  tasks: number;
  lastTask?: LastTask;
  /** Agents that have worked here, most recent first. */
  agents: string[];
  next?: NextStep;
};

export function projectState(input: {
  workspace: Pick<Workspace, "tabs">;
  lastTask?: LastTask;
  events: readonly ProjectEvent[];
}): ProjectState {
  const sources = sourceCounts(input.workspace);
  const taskEvents = input.events.filter((event) => event.kind === "task");
  const agents = [...new Set(taskEvents.sort((a, b) => b.at - a.at).flatMap((event) => (event.provider ? [event.provider] : [])))];
  const last = input.lastTask;

  let next: NextStep | undefined;
  if (last?.state === "needs_you") next = { kind: "answer_agent", text: `${agentDisplayName(last.provider)} is waiting for your answer`, sessionId: last.sessionId };
  else if (last?.state === "failed" || last?.state === "stopped")
    next = { kind: "retry_task", text: `${agentDisplayName(last.provider)}'s last task didn't finish — try again or give it to another agent`, sessionId: last.sessionId };
  else if (sources.total === 0) next = { kind: "add_sources", text: "Add sources from Chrome so agents have something to work from" };
  // Sources whose site keeps its content private are fine as they are, and never asked about (isContentUnavailable).
  else if (sources.attention > 0 && !last)
    next = {
      kind: "fix_sources",
      text: `${sources.attention} source${sources.attention === 1 ? "" : "s"} can't be read yet — upload the file or add a transcript`,
      count: sources.attention,
    };
  else if (!last) next = { kind: "first_task", text: `Give an agent its first task with ${sources.total} source${sources.total === 1 ? "" : "s"}` };
  else if (last.state === "done" && last.attention) next = { kind: "review_result", text: `Review ${agentDisplayName(last.provider)}'s result`, sessionId: last.sessionId };
  else if (last.state === "done")
    next = { kind: "continue_with_another", text: `Continue ${agentDisplayName(last.provider)}'s work with another agent, or give it the next task`, sessionId: last.sessionId };

  return { sources, tasks: taskEvents.length, ...(last ? { lastTask: last } : {}), agents, ...(next ? { next } : {}) };
}

/** "8 sources · project brief · previous result" — what a task is given, counted, for the work history. */
export function contextSummary(input: { sources: number; brief: boolean; previousResult: boolean; files?: number }): string {
  const parts: string[] = [];
  if (input.sources > 0) parts.push(`${input.sources} source${input.sources === 1 ? "" : "s"}`);
  if (input.files) parts.push(`${input.files} file${input.files === 1 ? "" : "s"}`);
  if (input.brief) parts.push("project brief");
  if (input.previousResult) parts.push("previous result");
  return parts.join(" · ");
}
