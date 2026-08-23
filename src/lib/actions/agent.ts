import { generateAgentTurn } from "@/lib/ai/gemini/client";
import type { AgentContent, GeminiResult } from "@/lib/ai/gemini/types";
import type { WorkspaceStore } from "@/lib/workspace/types";
import { ACTION_DECLARATIONS } from "./registry";
import { runAction } from "./run";

const MAX_TOOL_ITERATIONS = 6;
const FALLBACK_TEXT = "I ran into trouble finishing that — could you try rephrasing your request?";

export type PerformedAction = { name: string; ok: boolean; message: string };

export type AgentLoopResult =
  | { ok: true; text: string; store: WorkspaceStore; storeChanged: boolean; actions: PerformedAction[] }
  | Extract<GeminiResult<unknown>, { ok: false }>;

function summarizeData(data: unknown): string {
  try {
    const json = JSON.stringify(data);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "(unserializable result)";
  }
}

/**
 * Runs Gemini's tool-calling loop against the action layer. Gemini never
 * receives `store` directly — each iteration hands it a `name`/`args` pair
 * to `runAction`, which validates and executes against this snapshot, and
 * only the resulting JSON summary goes back to the model. `store` here is
 * threaded through purely so the FINAL, possibly-mutated snapshot can be
 * handed back to the caller (the route handler) to return to the browser,
 * which is the only place that can actually persist it.
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
      return {
        ok: true,
        text: turn.data.text || FALLBACK_TEXT,
        store,
        storeChanged: store !== params.store,
        actions: performed,
      };
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
      } else {
        performed.push({ name: call.name, ok: false, message: outcome.message });
        responseParts.push({ functionResponse: { name: call.name, response: { error: outcome.message } } });
      }
    }
    contents.push({ role: "function", parts: responseParts });
  }

  return { ok: true, text: FALLBACK_TEXT, store, storeChanged: store !== params.store, actions: performed };
}
