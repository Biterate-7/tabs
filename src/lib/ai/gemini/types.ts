export type GeminiFailureReason =
  | "missing-key"
  | "rate-limited"
  | "network-error"
  | "timeout"
  | "gemini-error"
  | "malformed-response";

export type GeminiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: GeminiFailureReason;
      /** Gemini's own (or the network layer's) error message — safe to log/relay, never contains the API key. */
      detail?: string;
      /** The upstream HTTP status Gemini responded with, when there was one. */
      status?: number;
    };

export type GeminiContent = {
  role: "user" | "model";
  text: string;
};

export type GenerateOptions = {
  model: string;
  systemInstruction?: string;
  contents: GeminiContent[];
  maxOutputTokens: number;
  /** JSON Schema-ish object; when set, Gemini is asked for application/json output. */
  responseSchema?: unknown;
};

/** One function Gemini may call — see generateAgentTurn(). `parameters` is left loose here so this module doesn't need to depend on the action layer's schema type. */
export type FunctionDeclaration = {
  name: string;
  description: string;
  parameters: unknown;
};

/**
 * One function call the model made, as PARSED out of a Gemini response —
 * see generateAgentTurn(). `thoughtSignature`, when Gemini 3 returns one, is
 * carried here purely so runAgentLoop can re-attach it to the right
 * functionCall Part when replaying this call back into the next request's
 * history (see AgentContentPart below) — nothing else should read it. It is
 * NOT a property of the wire `functionCall` object itself; on the actual
 * Gemini Part it's a SIBLING field (confirmed against Google's Gemini 3 /
 * thought-signatures docs), which is why AgentContentPart models it
 * separately rather than by reusing this type verbatim for `functionCall`.
 *
 * MUST be replayed back to Gemini byte-for-byte exactly as received — never
 * invented, decoded, hashed, truncated, or dropped — or Gemini 3 rejects the
 * next request with "Function call is missing a thought_signature...". For
 * a parallel batch of calls in one turn, Gemini generally signs only the
 * first Part; later ones in the same batch are commonly absent, and MUST
 * stay absent (never backfilled) when replayed.
 */
export type FunctionCall = {
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
};

export type AgentContentPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

/**
 * Gemini's `generateContent`/`streamGenerateContent` REST API only ever
 * accepts `role: "user"` or `role: "model"` on a Content entry — there is no
 * "function" role (that's an OpenAI-ism this API doesn't share; sending it
 * fails with "Role 'function' is not supported..."). A tool/function CALL
 * (the model deciding to invoke a tool) is a `role: "model"` turn whose
 * parts contain `functionCall`; a tool/function RESULT being reported back
 * is a `role: "user"` turn whose parts contain `functionResponse` — from the
 * API's point of view, that result is just more information supplied to the
 * model, exactly like a follow-up user message, distinguished only by its
 * part shape. See runAgentLoop in src/lib/actions/agent.ts, the only place
 * that constructs a functionResponse turn.
 */
export type AgentContent = {
  role: "user" | "model";
  parts: AgentContentPart[];
};

export type AgentTurnResult = {
  /** Concatenation of every text part in the response — usually empty when the model instead chose to call a function. */
  text: string;
  functionCalls: FunctionCall[];
  /**
   * Set (to `true`) only when Gemini's own `finishReason` for this turn was
   * `MAX_TOKENS` — i.e. `text` is a genuine, mid-thought truncation, not a
   * complete answer that just happens to be short. Omitted entirely (never
   * `false`) when the turn finished normally, so existing exact-shape
   * assertions on a normal turn's result are unaffected. See
   * runAgentLoop's use of this in src/lib/actions/agent.ts — a truncated
   * final answer must never be presented to the user as if it were complete.
   */
  truncated?: boolean;
};

export type AgentTurnOptions = {
  model: string;
  systemInstruction?: string;
  contents: AgentContent[];
  tools: FunctionDeclaration[];
  maxOutputTokens: number;
};
