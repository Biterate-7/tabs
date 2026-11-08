import { messagesOf } from "../canonical";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationTurn } from "@/lib/resources/types";
import type { ConversationRecord } from "../types";

/**
 * Conversations shaped like the ones people have — several turns, code,
 * lists, an AI recommending and a person deciding — for the extraction and
 * index tests. Fixtures, not evidence about any live AI app.
 */

export const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 9, 30, 12);

export const u = (text: string): ConversationTurn => ({ role: "user", text });
export const a = (text: string): ConversationTurn => ({ role: "assistant", text });

export function record(id: string, turns: ConversationTurn[], options: { provider?: AiProviderId; title?: string; workspaceId?: string; updatedAt?: number; identity?: string } = {}): ConversationRecord {
  const workspaceId = options.workspaceId ?? "w1";
  const recordId = `${workspaceId}:s:${id}`;
  const updatedAt = options.updatedAt ?? NOW - DAY;
  return {
    id: recordId,
    identity: options.identity ?? `${options.provider ?? "chatgpt"}:chat:${id}`,
    workspaceId,
    ref: { kind: "source", tabId: id },
    provider: options.provider ?? "chatgpt",
    title: options.title ?? "Untitled chat",
    createdAt: updatedAt - DAY,
    updatedAt,
    syncedAt: updatedAt,
    ingestion: "ready",
    contentHash: `${id.padEnd(16, "0").slice(0, 16)}`,
    capture: "page",
    messages: messagesOf(recordId, turns),
  };
}

/** ChatGPT: a sync bug, the AI proposes two fixes, the person picks one; a follow-up still fails. */
export const syncBugChat = (options: Parameters<typeof record>[2] = {}) =>
  record(
    "sync-bug",
    [
      u("My Next.js app loses saved conversations after a reload. The IndexedDB write seems to fail silently. How do I debug this?"),
      a(
        "This usually happens when the transaction closes before the write finishes.\n\nYou could approach it two ways:\n\n1. Wrap the write in a promise that resolves on `tx.oncomplete`.\n2. Move persistence into a service worker queue.\n\nI'd recommend wrapping the write in a promise that resolves on oncomplete, because it keeps the code in one place.\n\n```ts\nawait new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject })\n```"
      ),
      u("Let's go with option 1. I'll update the content store tomorrow."),
      a("Good choice. Next steps:\n- Add a test that reloads the store after a write\n- Log tx.onerror in development"),
      u("I tried it but it's still failing on Safari private windows. Why does Safari reject the write?"),
    ],
    { title: "IndexedDB writes lost after reload", ...options }
  );

/** Claude: the same objective, researched from another angle; an architecture decision. */
export const storageChoiceChat = (options: Parameters<typeof record>[2] = {}) =>
  record(
    "storage-choice",
    [
      u("I'm thinking about moving Hubble's conversation storage from IndexedDB to SQLite via Tauri. Should I use SQLite or keep IndexedDB?"),
      a("Both work. You should keep IndexedDB for the web build, since SQLite needs the desktop runtime. A better approach is a storage adapter with two backends."),
      u("Yes, that makes sense. We decided to use a storage adapter with IndexedDB on the web and SQLite in Tauri."),
      a("Great. The adapter should expose put, get and delete, and IndexedDB writes must wait for oncomplete."),
      u("I need to write the adapter interface and migrate the content store."),
    ],
    { provider: "claude", title: "Storage adapter for IndexedDB and SQLite", ...options }
  );

/** Gemini: unrelated learning chat. */
export const photosynthesisChat = (options: Parameters<typeof record>[2] = {}) =>
  record(
    "photosynthesis",
    [
      u("Explain how photosynthesis converts light into chemical energy."),
      a("Photosynthesis is the process plants use to turn light energy into chemical energy stored in glucose. It happens in two stages: the light-dependent reactions and the Calvin cycle."),
      u("Thanks, that makes sense."),
    ],
    { provider: "gemini", title: "How photosynthesis works", workspaceId: "w2", ...options }
  );
