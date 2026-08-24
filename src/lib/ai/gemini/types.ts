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

export type FunctionCall = {
  name: string;
  args: Record<string, unknown>;
};

export type AgentContentPart =
  | { text: string }
  | { functionCall: FunctionCall }
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
};

export type AgentTurnOptions = {
  model: string;
  systemInstruction?: string;
  contents: AgentContent[];
  tools: FunctionDeclaration[];
  maxOutputTokens: number;
};
