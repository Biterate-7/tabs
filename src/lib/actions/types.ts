import type { WorkspaceStore } from "@/lib/workspace/types";

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
  run(store: WorkspaceStore, args: Args): ActionRunResult<Data>;
};

/** Outcome of dispatching one named action through the registry — see run.ts. */
export type ActionDispatchResult =
  | { ok: true; name: string; args: unknown; data: unknown; store: WorkspaceStore }
  | { ok: false; name: string; message: string };
