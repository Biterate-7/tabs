/**
 * Shapes that are credentials far more often than they are anything else.
 *
 * Hubble's free texts that can reach an agent — a handoff instruction (1.4),
 * a workspace brief (1.5) — are scrubbed with these before they are kept or
 * sent: a key pasted by mistake goes nowhere. One list, so the two can never
 * disagree about what counts as a secret.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys (sk-…, sk-ant-…)
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\bxai-[A-Za-z0-9]{20,}/g, // xAI keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b(?:tdmcp|tdctx)_[A-Za-z0-9_-]{16,}/g, // Hubble's own MCP and session-context tokens
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, // Authorization header values
  // key=value pairs, and the header / cookie spellings of the same things
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|x-api-key|set-cookie|cookie|session[_-]?id)\s*[:=]\s*\S{6,}/gi,
];

export const REDACTED = "[redacted]";

/** Whether text holds something shaped like a credential. */
export function containsSecretShape(value: string): boolean {
  return SECRET_SHAPES.some((pattern) => {
    pattern.lastIndex = 0;
    const found = pattern.test(value);
    pattern.lastIndex = 0;
    return found;
  });
}

/** The text with everything shaped like a credential replaced by `[redacted]`. */
export function scrubSecretShapes(value: string): string {
  let text = value;
  for (const pattern of SECRET_SHAPES) text = text.replace(pattern, REDACTED);
  return text;
}
