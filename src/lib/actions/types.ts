import type { WorkspaceStore } from "@/lib/workspace/types";
import type { SemanticHint } from "@/lib/search/types";
import type { BrowserContextSnapshot } from "@/lib/browser/protocol";
import type { SemanticClusterHint } from "@/lib/organize/types";

/**
 * Gemini's function-calling `parameters` schema uses its protobuf-derived
 * Type enum (UPPERCASE), same as the existing collection-overview/gaps
 * responseSchema in the ask route — kept consistent here.
 */
export type ActionParameterSchema = {
  type: "OBJECT" | "STRING" | "ARRAY" | "INTEGER" | "NUMBER" | "BOOLEAN";
  description?: string;
  properties?: Record<string, ActionParameterSchema>;
  required?: string[];
  items?: ActionParameterSchema;
};

export type ActionValidation<Args> = { ok: true; args: Args } | { ok: false; message: string };

/**
 * Trusted, non-Gemini-controlled context handed alongside (store, args) to
 * an action's run(). Gemini never sees or supplies this — it's populated
 * server-side from data the browser sent directly (e.g. precomputed
 * semantic-similarity hints, since embeddings live only in the browser's
 * IndexedDB — see src/lib/ai/retrieve.ts). Optional and currently consumed
 * only by search_tabs; every other action's run() ignores it.
 */
export type ActionRunContext = {
  semanticHints?: SemanticHint[];
  /**
   * A live snapshot of the user's actual browser tabs/windows, gathered
   * client-side through the extension bridge (see src/lib/browser/context.ts)
   * and sent up alongside the question exactly like `semanticHints` — this
   * server-side action layer never talks to chrome.* itself (it can't; see
   * AGENTS.md's architectural constraint), so the browser read actions in
   * src/lib/actions/browser-read.ts answer entirely from this. `undefined`
   * means the extension wasn't connected when the request was made.
   */
  browserContext?: BrowserContextSnapshot;
  /**
   * Precomputed tab-to-tab semantic grouping signal for propose_auto_organize
   * (src/lib/actions/organize.ts) — see src/lib/organize/types.ts's
   * SemanticClusterHint. Like `semanticHints`, this never carries a raw
   * embedding vector; it's an opaque per-request cluster key computed
   * client-side (src/lib/ai/cluster.ts) from the browser's IndexedDB index.
   */
  semanticClusters?: SemanticClusterHint[];
};

export type ActionRunResult<Data> =
  | { ok: true; data: Data; store?: WorkspaceStore }
  | { ok: false; message: string };

/**
 * Method-shorthand signatures (not arrow-typed properties) are deliberate:
 * TypeScript checks method parameters bivariantly, which is what lets the
 * registry hold a `Record<string, ActionDefinition>` of otherwise-unrelated
 * Args/Data types without an `any` escape hatch. Each concrete action's own
 * `validate`/`run` are still fully typed where they're defined.
 */
export type ActionDefinition<Args = unknown, Data = unknown> = {
  name: string;
  description: string;
  /** Read-only actions never receive a mutated store back; write actions always must. */
  readOnly: boolean;
  parameters: ActionParameterSchema;
  validate(args: unknown): ActionValidation<Args>;
  run(store: WorkspaceStore, args: Args, ctx?: ActionRunContext): ActionRunResult<Data>;
};

/** Outcome of dispatching one named action through the registry — see run.ts. */
export type ActionDispatchResult =
  | { ok: true; name: string; args: unknown; data: unknown; store: WorkspaceStore }
  | { ok: false; name: string; message: string };
