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
