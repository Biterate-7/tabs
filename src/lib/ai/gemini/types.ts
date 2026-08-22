export type GeminiFailureReason =
  | "missing-key"
  | "rate-limited"
  | "network-error"
  | "gemini-error"
  | "malformed-response";

export type GeminiResult<T> = { ok: true; data: T } | { ok: false; reason: GeminiFailureReason };

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
