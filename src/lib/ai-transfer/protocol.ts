import { z } from "zod";
import { AI_PROVIDER_IDS, aiProviderName } from "@/lib/providers/registry";
import { TRANSFER_LIMITS } from "./package";
import type { AiProviderId } from "@/lib/providers/registry";
import type { TransferMode } from "./package";

/**
 * Use in AI's wire format between this page and Hubble for Chrome.
 *
 *     page ──postMessage──► content script ──runtime.sendMessage──► background
 *       HUBBLE_AI_TRANSFER { opId, provider, mode, text, fallbackText?, files[] }
 *     page ◄── content script ◄── background (chrome.tabs.sendMessage to this tab)
 *       HUBBLE_AI_TRANSFER_PROGRESS { opId, state }
 *       HUBBLE_AI_TRANSFER_RESULT   { opId, ok, … }
 *
 * The extension's copy of these names and limits is extension/src/
 * ai-transfer.js; src/lib/ai-transfer/protocol.test.ts holds the two to the
 * same values.
 *
 * - **One operation, one id.** `opId` names one transfer the person asked
 *   for. Sending the same id again never types or sends twice: a finished
 *   operation answers with its result, a running one with "already-running".
 * - **The page decides nothing about the AI app's page.** It says what to
 *   put where; the extension checks every field again (a content script is a
 *   transport, never a trust boundary), only accepts it from a Hubble tab,
 *   and reports a state only once it has seen it happen.
 * - **Nothing is logged.** Neither side logs message text or file bytes.
 */

export const MSG_AI_TRANSFER = "HUBBLE_AI_TRANSFER";
export const MSG_AI_TRANSFER_PROGRESS = "HUBBLE_AI_TRANSFER_PROGRESS";
export const MSG_AI_TRANSFER_RESULT = "HUBBLE_AI_TRANSFER_RESULT";
/** Answered by the content script itself: which transfer protocol this extension speaks. */
export const MSG_AI_TRANSFER_HELLO = "HUBBLE_AI_TRANSFER_HELLO";
export const MSG_AI_TRANSFER_HELLO_RESULT = "HUBBLE_AI_TRANSFER_HELLO_RESULT";

export const AI_TRANSFER_PROTOCOL = 1;

export const AI_TRANSFER_WIRE_LIMITS = {
  opId: 64,
  text: TRANSFER_LIMITS.messageChars,
  files: 11,
  fileName: 255,
  fileBytes: TRANSFER_LIMITS.fileBytes,
  totalFileBytes: TRANSFER_LIMITS.totalFileBytes,
} as const;

/** Every state a transfer can report, in the order they happen. */
export const TRANSFER_STATES = [
  "preparing",
  "opening-provider",
  "waiting-for-permission",
  "waiting-for-provider",
  "attaching",
  "inserting",
  "submitting",
  "ready-for-review",
  "submitted",
  "failed",
] as const;

export type TransferState = (typeof TRANSFER_STATES)[number];

/** States the extension reports while it works (the page itself says "preparing"). */
const PROGRESS_STATES = new Set<TransferState>(["opening-provider", "waiting-for-permission", "waiting-for-provider", "attaching", "inserting", "submitting"]);

export type TransferFile = { name: string; type: string; size: number; /** base64 of the bytes */ data: string };

export type TransferRequest = {
  opId: string;
  provider: AiProviderId;
  mode: TransferMode;
  text: string;
  fallbackText?: string;
  files: TransferFile[];
};

export const TRANSFER_ERRORS = [
  "invalid",
  "unsupported-provider",
  "permission-denied",
  "permission-timeout",
  "sign-in-required",
  "provider-check",
  "provider-not-loaded",
  "unexpected-page",
  "no-composer",
  "composer-has-draft",
  "not-inserted",
  "attach-failed",
  "tab-closed",
  "already-running",
  "interrupted",
  "failed",
  // Page-side only.
  "no-extension",
  "extension-outdated",
  "timeout",
] as const;

export type TransferError = (typeof TRANSFER_ERRORS)[number];

export type NotAttached = { name: string; reason: string };

export type TransferResult =
  | {
      opId: string;
      ok: true;
      state: "ready-for-review" | "submitted";
      /** Files the AI app showed in its message box. */
      attached: string[];
      notAttached: NotAttached[];
      /** The all-text message was typed because a file didn't attach. */
      usedFallback: boolean;
      /** Send was asked for and didn't happen: why (the message is still in the box). */
      submitProblem?: string;
      /** The tab was one already open on a new chat, rather than a new one. */
      reusedTab: boolean;
    }
  | { opId: string; ok: false; error: TransferError; notAttached?: NotAttached[]; detail?: string };

const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isOpId(value: unknown): value is string {
  return typeof value === "string" && OP_ID.test(value);
}

export function newOpId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `op_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** How many bytes a base64 string decodes to. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const fileSchema = z.object({
  name: z.string().min(1).max(AI_TRANSFER_WIRE_LIMITS.fileName),
  type: z.string().max(200),
  size: z.number().int().min(0).max(AI_TRANSFER_WIRE_LIMITS.fileBytes),
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
});

const requestSchema = z.object({
  opId: z.string().regex(OP_ID),
  provider: z.enum(AI_PROVIDER_IDS as unknown as [AiProviderId, ...AiProviderId[]]),
  mode: z.enum(["prepare", "send"]),
  text: z.string().min(1).max(AI_TRANSFER_WIRE_LIMITS.text),
  fallbackText: z.string().min(1).max(AI_TRANSFER_WIRE_LIMITS.text).optional(),
  files: z.array(fileSchema).max(AI_TRANSFER_WIRE_LIMITS.files),
});

/**
 * A request checked before it leaves the page: the same bounds the extension
 * enforces, so a refusal is said here, in words, rather than after a round
 * trip. `undefined` when it isn't one.
 */
export function checkTransferRequest(value: unknown): TransferRequest | undefined {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const request = parsed.data;
  let total = 0;
  for (const file of request.files) {
    if (base64Bytes(file.data) !== file.size) return undefined;
    total += file.size;
  }
  if (total > AI_TRANSFER_WIRE_LIMITS.totalFileBytes) return undefined;
  return request;
}

const notAttachedSchema = z.array(z.object({ name: z.string().max(AI_TRANSFER_WIRE_LIMITS.fileName), reason: z.string().max(300) })).max(AI_TRANSFER_WIRE_LIMITS.files);

const resultSchema = z.union([
  z.object({
    opId: z.string(),
    ok: z.literal(true),
    state: z.enum(["ready-for-review", "submitted"]),
    attached: z.array(z.string().max(AI_TRANSFER_WIRE_LIMITS.fileName)).max(AI_TRANSFER_WIRE_LIMITS.files),
    notAttached: notAttachedSchema,
    usedFallback: z.boolean(),
    submitProblem: z.string().max(300).optional(),
    reusedTab: z.boolean(),
  }),
  z.object({
    opId: z.string(),
    ok: z.literal(false),
    error: z.string().max(60),
    notAttached: notAttachedSchema.optional(),
    detail: z.string().max(300).optional(),
  }),
]);

/**
 * The extension's answer, re-read. Anything malformed, or an error this
 * protocol doesn't name, becomes "failed" — never a success.
 */
export function readTransferResult(opId: string, value: unknown): TransferResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success || parsed.data.opId !== opId) return { opId, ok: false, error: "failed" };
  const result = parsed.data;
  if (result.ok) return result;
  const error = (TRANSFER_ERRORS as readonly string[]).includes(result.error) ? (result.error as TransferError) : "failed";
  return { opId, ok: false, error, ...(result.notAttached ? { notAttached: result.notAttached } : {}), ...(result.detail ? { detail: result.detail } : {}) };
}

/** A progress report, re-read: only a state the extension reports while working. */
export function readTransferProgress(value: unknown): { opId: string; state: TransferState } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { opId, state } = value as { opId?: unknown; state?: unknown };
  if (!isOpId(opId) || typeof state !== "string" || !PROGRESS_STATES.has(state as TransferState)) return undefined;
  return { opId, state: state as TransferState };
}

/** What a state means, as the dialog says it. */
export function stateWords(state: TransferState, provider: AiProviderId): string {
  const name = aiProviderName(provider);
  switch (state) {
    case "preparing":
      return "Preparing the context…";
    case "opening-provider":
      return `Opening ${name}…`;
    case "waiting-for-permission":
      return `Allow Hubble for Chrome to use ${name} — a small window is asking.`;
    case "waiting-for-provider":
      return `Waiting for ${name} to load…`;
    case "attaching":
      return `Attaching files in ${name}…`;
    case "inserting":
      return `Putting the message into ${name}…`;
    case "submitting":
      return `Sending in ${name}…`;
    case "ready-for-review":
      return `Ready in ${name}. Review it there, then send it yourself.`;
    case "submitted":
      return `Sent in ${name}.`;
    case "failed":
      return "Not transferred.";
  }
}

/** What went wrong, and what to do next, in one or two sentences. */
export function errorWords(error: TransferError, provider: AiProviderId): string {
  const name = aiProviderName(provider);
  switch (error) {
    case "permission-denied":
      return `Hubble for Chrome wasn't allowed to use ${name}, so nothing was transferred. Try again and choose Allow, or copy instead.`;
    case "permission-timeout":
      return `No answer to the permission request, so nothing was transferred. Try again, or copy instead.`;
    case "sign-in-required":
      return `${name} wants you to sign in. Sign in there, then try again.`;
    case "provider-check":
      return `${name} is showing a security check. Complete it in that tab yourself, then try again.`;
    case "provider-not-loaded":
      return `${name} didn't finish loading. Check that tab, then try again.`;
    case "unexpected-page":
      return `${name} opened a page Hubble didn't expect, so nothing was typed. Open a new chat there and try again.`;
    case "no-composer":
      return `Hubble couldn't find ${name}'s message box (the page may have changed). Copy instead and paste it there.`;
    case "composer-has-draft":
      return `${name}'s message box already has text you haven't sent, and Hubble won't overwrite it. Send or clear it, then try again — or copy instead.`;
    case "not-inserted":
      return `${name} didn't take the text. Nothing was sent. Copy instead and paste it there.`;
    case "attach-failed":
      return `${name} didn't show the file as attached, so nothing was typed. Untick “Attach original files” to send their text instead, or copy.`;
    case "tab-closed":
      return `The ${name} tab was closed. Try again.`;
    case "already-running":
      return "That transfer is still running.";
    case "interrupted":
      return "Hubble for Chrome stopped before it finished. Check the tab, then try again.";
    case "no-extension":
      return "Install Hubble for Chrome to place this in the chat for you. Until then, copy it.";
    case "extension-outdated":
      return "Update Hubble for Chrome to place this in the chat for you. Until then, copy it.";
    case "timeout":
      return "Hubble for Chrome didn't answer in time. Check the tab, then try again.";
    case "unsupported-provider":
    case "invalid":
    case "failed":
      return "Something went wrong, and nothing was sent. Try again, or copy instead.";
  }
}
