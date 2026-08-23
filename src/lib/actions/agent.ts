import { generateAgentTurn } from "@/lib/ai/gemini/client";
import type { AgentContent, GeminiResult } from "@/lib/ai/gemini/types";
import type { WorkspaceStore } from "@/lib/workspace/types";
import { ACTION_DECLARATIONS } from "./registry";
import { runAction } from "./run";
import { describePlannedAction, isWriteAction, planRequiresConfirmation, summarizePlan } from "./plan";
import type { PlannedAction } from "./plan";

const MAX_TOOL_ITERATIONS = 6;
const FALLBACK_TEXT = "I ran into trouble finishing that — could you try rephrasing your request?";
const DEFAULT_PREVIEW_INTRO = "Here's what I want to change:";

export type PerformedAction = { name: string; ok: boolean; message: string };

export type AgentLoopResult =
  | { ok: true; kind: "resolved"; text: string; store: WorkspaceStore; storeChanged: boolean; actions: PerformedAction[] }
  | { ok: true; kind: "preview"; text: string; plan: PlannedAction[]; summary: string }
  | Extract<GeminiResult<unknown>, { ok: false }>;

function summarizeData(data: unknown): string {
  try {
    const json = JSON.stringify(data);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "(unserializable result)";
  }
}

function resolved(text: string, store: WorkspaceStore, original: WorkspaceStore, actions: PerformedAction[]): AgentLoopResult {
  return { ok: true, kind: "resolved", text: text || FALLBACK_TEXT, store, storeChanged: store !== original, actions };
}

function preview(text: string, plan: PlannedAction[]): AgentLoopResult {
  return { ok: true, kind: "preview", text: text || DEFAULT_PREVIEW_INTRO, plan, summary: summarizePlan(plan) };
}

/**
 * Runs Gemini's tool-calling loop against the action layer. Gemini never
 * receives `store` directly — each iteration hands it a `name`/`args` pair
 * to `runAction`, which validates and executes against a working snapshot,
 * and only the resulting JSON summary goes back to the model.
 *
 * That working snapshot is a SCRATCH copy, not the real one: write actions
 * execute against it during planning purely so a multi-step plan (e.g.
 * "create workspace X, then move tabs into it") stays coherent for Gemini
 * to reason about — the newly "created" workspace needs a real-looking id
 * for the next tool call to reference. But the scratch store is only ever
 * used to decide WHAT to propose; every write action's name+validated-args
 * is also recorded into `plan`, in order. Once the loop ends, exactly one
 * of two things happens with that plan, and never both:
 *   - small/single plan → committed immediately: the scratch store IS the
 *     result (kind: "resolved"), same as if this loop had always mutated
 *     directly — this is the "immediate action" path.
 *   - large/multi-step plan → the scratch store is thrown away entirely
 *     (kind: "preview"); nothing was actually applied. Only `plan` (the
 *     ordered name+args list) survives, to be re-validated and executed for
 *     real later by applyPlan() once the user approves it.
 */
export async function runAgentLoop(params: {
  model: string;
  systemInstruction: string;
  contents: AgentContent[];
  store: WorkspaceStore;
  maxOutputTokens: number;
}): Promise<AgentLoopResult> {
  const contents = [...params.contents];
  let store = params.store;
  const performed: PerformedAction[] = [];
  const plan: PlannedAction[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const turn = await generateAgentTurn({
      model: params.model,
      systemInstruction: params.systemInstruction,
      contents,
      tools: ACTION_DECLARATIONS,
      maxOutputTokens: params.maxOutputTokens,
    });

    if (!turn.ok) return turn;

    if (turn.data.functionCalls.length === 0) {
      if (plan.length === 0) return resolved(turn.data.text, store, params.store, performed);
      return planRequiresConfirmation(plan) ? preview(turn.data.text, plan) : resolved(turn.data.text, store, params.store, performed);
    }

    contents.push({
      role: "model",
      parts: turn.data.functionCalls.map((call) => ({ functionCall: call })),
    });

    const responseParts: AgentContent["parts"] = [];
    for (const call of turn.data.functionCalls) {
      const outcome = runAction(call.name, call.args, store);
      if (outcome.ok) {
        store = outcome.store;
        performed.push({ name: call.name, ok: true, message: summarizeData(outcome.data) });
        responseParts.push({ functionResponse: { name: call.name, response: { result: outcome.data } } });

        if (isWriteAction(call.name)) {
          plan.push({ name: call.name, args: outcome.args, ...describePlannedAction(call.name, outcome.data) });
        }
      } else {
        performed.push({ name: call.name, ok: false, message: outcome.message });
        responseParts.push({ functionResponse: { name: call.name, response: { error: outcome.message } } });
      }
    }
    contents.push({ role: "function", parts: responseParts });
  }

  if (plan.length > 0 && planRequiresConfirmation(plan)) return preview(DEFAULT_PREVIEW_INTRO, plan);
  return resolved(FALLBACK_TEXT, store, params.store, performed);
}
