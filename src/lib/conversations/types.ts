import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationCaptureMethod, ConversationTurn } from "@/lib/resources/types";

/**
 * An AI conversation on its way into Hubble — from the open page (Hubble for
 * Chrome), a provider's export file, or a paste. Every door produces this
 * one shape, already validated and bounded, and one function saves it
 * (./save.ts).
 *
 * Its text is data: what a person and an AI said, kept so it can be found
 * and quoted later. Nothing in Hubble ever executes it, follows it or treats
 * it as an instruction.
 */
export type ConversationInput = {
  provider: AiProviderId;
  title: string;
  /** The conversation's own address (canonical, no query or fragment). Absent for a paste that came without one. */
  url?: string;
  /** The provider's id for it, from its address or export. */
  conversationId?: string;
  turns: ConversationTurn[];
  /**
   * Text that could not be split into turns (a paste with no "You:" /
   * "ChatGPT:" labels). Kept whole rather than guessed at.
   */
  text?: string;
  method: ConversationCaptureMethod;
  /** When the conversation itself was created / last changed, when the source said. */
  createdAt?: number;
  updatedAt?: number;
};

export const CONVERSATION_LIMITS = {
  title: 300,
  turns: 4_000,
  turnText: 100_000,
  /** Every turn together — a long research thread fits; a runaway page does not. */
  totalChars: 2_000_000,
  /** An export file, as chosen. */
  importBytes: 100 * 1024 * 1024,
  /** Conversations taken from one export file. */
  importConversations: 5_000,
} as const;
