import { createClaudeCodeControlSeam } from "@/lib/agents/control/providers/claude-code/seam";
import { createCodexControlAdapter } from "@/lib/agents/control/providers/codex";
import { createClaudeCodeConnector, CLAUDE_CODE_DESCRIPTOR } from "./providers/claude-code";
import { createDeclaredConnector } from "./providers/declared";
import { NO_CAPABILITIES } from "./types";
import type { ClaudeCodeConnectorOptions } from "./providers/claude-code";
import type { ConnectorRegistration } from "./registry";
import type { ProviderDescriptor } from "./types";

/**
 * Which providers TabDump ships, and how to build each one.
 *
 * **The only provider-aware module in the connector layer.** The registry,
 * the manager, the persistence, the hooks, the settings UI and the workspace
 * all work against whatever they are given; this file is the one place that
 * names Claude Code, Codex, Gemini and Grok. That is what makes adding a
 * provider an adapter problem: a new integration is a connector file and a
 * registration here, and nothing else in the application changes.
 *
 * ## On the three that do not work yet
 *
 * Codex, Gemini and Grok are registered, described, capability-declared and
 * honest. They are not faked. Each would be observed by reading local state
 * the respective CLI writes, and TabDump has not verified any of those
 * formats against a real installation — so building a reader for one would
 * mean guessing at a schema and shipping a connector that reports confident
 * nonsense whenever the guess was wrong. Their capability sets are therefore
 * empty rather than aspirational: `NO_CAPABILITIES` is what TabDump can
 * actually observe today, and a capability list that promised runs and events
 * would be a promise the connector cannot keep.
 *
 * When one is implemented, its registration below swaps
 * `createDeclaredConnector` for a real connector and its descriptor gains the
 * capabilities that were verified — a change confined to this file and the
 * new provider's own.
 *
 * ## The control plane
 *
 * A registration may also carry `createControl`. Observation and control are
 * separate adapters with separate capabilities, so a provider can be fully
 * observable and entirely undrivable — which is exactly what Claude Code is
 * today, and the reason the two are declared apart rather than inferred from
 * each other.
 *
 * Claude Code and Codex have control seams registered; both are
 * `createUnimplementedControlAdapter`, declare no capabilities, and refuse
 * every operation. Gemini, Grok and Custom have no control registration at
 * all, which reads as "not drivable" everywhere without a stub having to say
 * so. Registering a seam is a statement that the next phase will implement
 * it, not that anything works now.
 */

const CODEX_DESCRIPTOR: ProviderDescriptor = {
  provider: "openai-codex",
  displayName: "OpenAI / Codex",
  summary: "Would observe Codex sessions and the files they change.",
  capabilities: NO_CAPABILITIES,
  requirement:
    "TabDump cannot observe Codex from this environment yet. The connector boundary is in place; what is missing is a verified way to read Codex activity locally.",
};

const GEMINI_DESCRIPTOR: ProviderDescriptor = {
  provider: "gemini",
  displayName: "Gemini",
  summary: "Would observe Gemini agent sessions and their activity.",
  capabilities: NO_CAPABILITIES,
  requirement:
    "TabDump cannot observe Gemini from this environment yet. The connector boundary is in place; what is missing is a verified way to read Gemini activity locally.",
};

const GROK_DESCRIPTOR: ProviderDescriptor = {
  provider: "grok",
  displayName: "Grok",
  summary: "Would observe Grok agent sessions and their activity.",
  capabilities: NO_CAPABILITIES,
  requirement:
    "TabDump cannot observe Grok from this environment yet. The connector boundary is in place; what is missing is a verified way to read Grok activity locally.",
};

/**
 * The custom-agent seam.
 *
 * Registered so the boundary is visible in the product rather than only in
 * the code: someone integrating their own agent implements `AgentConnector`
 * and registers it, and the domain, the workspace and the UI accept it
 * without modification. It obeys the same security boundary as every other
 * connector — a custom connector can deliver observations and can do nothing
 * else, because the contract has no member that would let it.
 */
const CUSTOM_DESCRIPTOR: ProviderDescriptor = {
  provider: "custom",
  displayName: "Custom agent",
  summary: "Bring your own agent by implementing the connector contract.",
  capabilities: NO_CAPABILITIES,
  requirement:
    "A custom connector is added in code: implement the connector contract and register it in the catalog. See docs/phase-17-multi-agent-connector-framework.md.",
};

export type CatalogOptions = {
  /** Passed to the Claude Code connector. Tests inject the adapter's fetch and scheduler here. */
  claudeCode?: ClaudeCodeConnectorOptions;
};

/**
 * Every provider TabDump ships, in display order.
 *
 * Claude Code first because it is the one that works; the rest follow in a
 * stable order so the settings list does not reshuffle between renders.
 */
export function defaultConnectorCatalog(options: CatalogOptions = {}): ConnectorRegistration[] {
  return [
    {
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      create: () => createClaudeCodeConnector(options.claudeCode),
      createControl: createClaudeCodeControlSeam,
    },
    {
      descriptor: CODEX_DESCRIPTOR,
      create: () =>
        createDeclaredConnector({
          descriptor: CODEX_DESCRIPTOR,
          unavailableDetail: CODEX_DESCRIPTOR.requirement!,
        }),
      createControl: createCodexControlAdapter,
    },
    {
      descriptor: GEMINI_DESCRIPTOR,
      create: () =>
        createDeclaredConnector({
          descriptor: GEMINI_DESCRIPTOR,
          unavailableDetail: GEMINI_DESCRIPTOR.requirement!,
        }),
    },
    {
      descriptor: GROK_DESCRIPTOR,
      create: () =>
        createDeclaredConnector({
          descriptor: GROK_DESCRIPTOR,
          unavailableDetail: GROK_DESCRIPTOR.requirement!,
        }),
    },
    {
      descriptor: CUSTOM_DESCRIPTOR,
      create: () =>
        createDeclaredConnector({
          descriptor: CUSTOM_DESCRIPTOR,
          unavailableDetail: CUSTOM_DESCRIPTOR.requirement!,
        }),
    },
  ];
}

export {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  GEMINI_DESCRIPTOR,
  GROK_DESCRIPTOR,
  CUSTOM_DESCRIPTOR,
};
