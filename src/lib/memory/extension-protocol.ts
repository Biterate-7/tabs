import { z } from "zod";
import { isAiProviderId } from "@/lib/providers/registry";
import { MAX_SESSION_TABS } from "@/lib/sessions/types";
import type { KnowledgeItemRef } from "./items";
import type { AiProviderId } from "@/lib/providers/registry";

/**
 * The page's half of Hubble for Chrome's memory requests.
 *
 *     popup ──► background ──► content script ──► this page
 *       HUBBLE_PAGE_REQUEST { requestId, kind, args }
 *     popup ◄── background ◄── content script ◄── this page
 *       HUBBLE_PAGE_RESPONSE { requestId, ok, result | error }
 *
 * The extension asks; only this page knows the person's projects and can
 * read their saved text (it lives in this origin's storage). Every request
 * is re-read here with a closed schema — the content script is a transport,
 * never a trust boundary — and every answer is bounded and holds only what
 * the request needs: names, titles, short snippets, or the context text the
 * person asked to build.
 *
 *   projects  the person's projects, by id and name
 *   capture   save a conversation the extension read from an AI app's page
 *   search    find items to reuse, in one project or every project
 *   bundle    build the context text for chosen items (lib/memory/bundle.ts)
 *   reused    the person copied or inserted context — recorded locally
 *   save-session  save the tabs the extension read from a Chrome window as a
 *                 session (lib/sessions) — addresses, titles and icons only
 */

export const MSG_PAGE_REQUEST = "HUBBLE_PAGE_REQUEST";
export const MSG_PAGE_RESPONSE = "HUBBLE_PAGE_RESPONSE";

export const EXTENSION_SEARCH_LIMIT = 20;

const id = z.string().min(1).max(200);
const ref = z.union([
  z.object({ kind: z.literal("source"), tabId: id }),
  z.object({ kind: z.literal("note"), noteId: id }),
]);

/** One tab of a session the extension read from Chrome. Re-read again by lib/sessions/model.ts before it is kept. */
const sessionTab = z.object({
  url: z.string().min(1).max(4000),
  title: z.string().max(2000).optional(),
  favicon: z.string().max(9000).optional(),
  pinned: z.boolean().optional(),
});

const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("projects"), args: z.object({}).loose().optional() }),
  z.object({
    kind: z.literal("capture"),
    // The capture itself is re-read by lib/conversations/capture.ts; here only its envelope.
    args: z.object({ workspaceId: id, capture: z.unknown() }),
  }),
  z.object({
    kind: z.literal("search"),
    args: z.object({ query: z.string().max(500), workspaceId: id.optional() }),
  }),
  z.object({
    kind: z.literal("bundle"),
    args: z.object({
      workspaceId: id,
      refs: z.array(ref).min(1).max(50),
      request: z.string().max(2000).optional(),
      length: z.enum(["short", "standard", "long"]).optional(),
    }),
  }),
  z.object({
    kind: z.literal("reused"),
    args: z.object({ workspaceId: id, items: z.number().int().min(0).max(50), provider: z.string().max(40).optional(), how: z.enum(["copied", "inserted"]) }),
  }),
  z.object({
    kind: z.literal("save-session"),
    args: z.object({
      name: z.string().max(500).optional(),
      workspaceId: id.optional(),
      tabs: z.array(sessionTab).min(1).max(MAX_SESSION_TABS),
    }),
  }),
]);

export type PageRequest = z.infer<typeof requestSchema>;

export type PageRequestEnvelope = { requestId: string; request: PageRequest };

/** A request as it arrived in a message's payload, or `undefined` when it is not one. */
export function readPageRequest(payload: unknown): PageRequestEnvelope | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const raw = payload as { requestId?: unknown; kind?: unknown; args?: unknown };
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0 || raw.requestId.length > 100) return undefined;
  const parsed = requestSchema.safeParse({ kind: raw.kind, args: raw.args ?? {} });
  return parsed.success ? { requestId: raw.requestId, request: parsed.data } : undefined;
}

export function providerOrUndefined(value: unknown): AiProviderId | undefined {
  return isAiProviderId(value) ? value : undefined;
}

export const BUNDLE_LENGTH_BUDGET = { short: 5_000, standard: 12_000, long: 30_000 } as const;

export type ExtensionSearchHit = {
  workspaceId: string;
  projectName: string;
  ref: KnowledgeItemRef;
  title: string;
  type: string;
  provider?: AiProviderId;
  snippet?: string;
  hasText: boolean;
};

export type PageResponse = { requestId: string; ok: true; result: unknown } | { requestId: string; ok: false; error: string };
