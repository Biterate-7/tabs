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
