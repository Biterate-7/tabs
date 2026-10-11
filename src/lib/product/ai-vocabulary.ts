import { platformProvider } from "@/lib/agents/platform/catalog"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"

/**
 * How AI is spoken about to someone who is not a developer.
 *
 * The connection layer underneath is precise on purpose — twenty-odd phases,
 * runtimes, adapters, transports — and every one of those words stays where
 * it is, in the Connect dialog's details, Settings → AI Connections →
 * details, and the Command Centre. This module is the translation a student
 * reads: the AI's plain name, and where it stands as one of a handful of
 * states with exactly one thing to do next.
 *
 * Nothing here decides anything. A phase still comes from the runtime's own
 * report (lib/agents/platform/lifecycle.ts); this only words it.
 */

const SHORT_NAMES: Partial<Record<AgentProviderId, string>> = {
  "claude-code": "Claude",
  "openai-codex": "Codex",
  gemini: "Gemini",
  grok: "Grok",
  custom: "Other AI",
}

/** "Claude", "Gemini", "Codex", "Grok" — the name a student knows, not the CLI's. */
export function aiName(provider: AgentProviderId | string | null | undefined): string {
  if (!provider) return "AI"
  const short = SHORT_NAMES[provider as AgentProviderId]
  if (short) return short
  return platformProvider(provider as AgentProviderId)?.displayName ?? "AI"
}

/**
 * The few states a student sees.
 *
 *   connected      Connected ✓
 *   installed      Installed — one click to connect
 *   available      Not set up yet — Connect
 *   not-detected   Not on this computer
 *   working        Connecting… / Signing in…
 *   needs-you      Waiting on you: sign in, or finish connecting
 *   broken         Needs reconnecting — Fix connection
 *   unavailable    Can't be used here (and why, under Details)
 *   checking       Not checked yet
 */
export type AiConnectionKind =
  | "connected"
  | "installed"
  | "available"
  | "not-detected"
  | "working"
  | "needs-you"
  | "broken"
  | "unavailable"
  | "checking"

export type AiConnectionState = {
  kind: AiConnectionKind
  /** One or two words, beside the name. */
  label: string
  /** The one button, when there is something to do. */
  action?: string
}

export function aiConnectionState(phase: ConnectionPhase): AiConnectionState {
  switch (phase) {
    case "connected":
      return { kind: "connected", label: "Connected" }
    case "detected":
      return { kind: "installed", label: "Installed", action: "Connect" }
    case "not_installed":
      return { kind: "not-detected", label: "Not detected", action: "Set up" }
    case "needs_adapter":
      return { kind: "available", label: "Needs a quick setup", action: "Set up" }
    case "connecting":
      return { kind: "working", label: "Connecting…" }
    case "authenticating":
      return { kind: "working", label: "Signing in…" }
    case "sign_in_required":
    case "auth_expired":
    case "unverified":
      return { kind: "needs-you", label: "Sign in needed", action: "Sign in" }
    case "awaiting_approval":
      return { kind: "needs-you", label: "Almost connected", action: "Finish" }
    case "disconnected":
    case "timeout":
    case "connection_lost":
    case "auth_failed":
    case "error":
      return { kind: "broken", label: "Needs reconnecting", action: "Fix connection" }
    case "sessions_unavailable":
    case "auth_unsupported":
      return { kind: "unavailable", label: "Can't be used here", action: "Details" }
    // Whether the desktop app is the answer depends on the AI (see availableInDesktop): the list says so, with a link, when it is.
    case "runtime_unavailable":
      return { kind: "unavailable", label: "Not available here", action: "Details" }
    case "unknown":
      return { kind: "checking", label: "Not checked yet", action: "Connect" }
  }
}

/** The sentence under a broken connection — never a raw error. */
export function aiRecoverySentence(provider: AgentProviderId | string): string {
  return `We couldn't connect to ${aiName(provider)}.`
}
