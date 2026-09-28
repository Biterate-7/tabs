import { sanitizeText } from "@/lib/agents/context/sanitize";
import type { AgentContextAttachment } from "@/lib/agents/control/context";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * What the user pointed a session at in Hubble — its **focus** (workspace ↔
 * agent integration).
 *
 * ## Focus is attention, not access
 *
 * A session is bound to one workspace (J.3) and may read all of it on
 * request; that binding is the security boundary and nothing here changes it.
 * Focus is narrower and says something different: *these* tabs and *these*
 * collections are what the user selected when they asked. It grants nothing —
 * every read still goes through `authorizeContextRequest`, and every write
 * through the broker — and it can only name things inside the bound
 * workspace, checked here against the snapshot the runtime holds.
 *
 * ## Ids only
 *
 * The runtime keeps references, never copies: titles and names are looked up
 * in the bound snapshot at the moment an agent reads them, so a renamed tab
 * reads under its new name and a removed one simply drops out. There is no
 * second store of workspace content.
 */

/** Bounds, so a focus can never be the "send the whole workspace" it exists to avoid. */
export const FOCUS_LIMITS = { tabs: 50, collections: 20 } as const;

export type SessionFocus = {
  tabIds: readonly string[];
  collectionIds: readonly string[];
};

export const EMPTY_FOCUS: SessionFocus = { tabIds: [], collectionIds: [] };

export function isEmptyFocus(focus: SessionFocus | undefined): boolean {
  return !focus || (focus.tabIds.length === 0 && focus.collectionIds.length === 0);
}

function uniqueBounded(ids: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** A focus with duplicates removed and each list held to its bound. */
export function normalizeFocus(focus: SessionFocus): SessionFocus {
  return {
    tabIds: uniqueBounded(focus.tabIds, FOCUS_LIMITS.tabs),
    collectionIds: uniqueBounded(focus.collectionIds, FOCUS_LIMITS.collections),
  };
}

/**
 * The tab and collection references among a message's attachments.
 *
 * Attachments are the Phase E bridge's output — the one channel a selection
 * reaches an agent by — so the focus is read off them rather than sent
 * separately: what the agent is told and what it can look up again are the
 * same set by construction.
 */
export function focusFromAttachments(attachments: readonly AgentContextAttachment[]): SessionFocus {
  return normalizeFocus({
    tabIds: attachments.filter((attachment) => attachment.kind === "tab").map((attachment) => attachment.id),
    collectionIds: attachments
      .filter((attachment) => attachment.kind === "collection")
      .map((attachment) => attachment.id),
  });
}

/**
 * Whether attachments stay inside one workspace, as far as can be known
 * without its contents: any `workspace` attachment must be that workspace.
 */
export function attachmentsStayIn(attachments: readonly AgentContextAttachment[], workspaceId: string): boolean {
  return attachments.every((attachment) => attachment.kind !== "workspace" || attachment.id === workspaceId);
}

/**
 * Whether every reference names something in this snapshot — the bound
 * workspace. Fails closed: an id the runtime cannot find is treated as
 * foreign, including a tab beyond a truncated snapshot's bounds (the
 * Command Centre filters its focus to the snapshot it syncs, so a genuine
 * one is never refused).
 */
export function focusFitsSnapshot(snapshot: SessionContextSnapshot, focus: SessionFocus): boolean {
  const tabs = new Set(snapshot.workspace.tabs.map((tab) => tab.id));
  const collections = new Set(snapshot.collections.map((collection) => collection.id));
  return focus.tabIds.every((id) => tabs.has(id)) && focus.collectionIds.every((id) => collections.has(id));
}

/** The one sentence an agent reads beside its focus. Fixed text. */
export const FOCUS_NOTE =
  "The user pointed you at these in Hubble. Treat them as what their request is about; the rest of this workspace stays readable if you need it.";

export type FocusView = {
  tabs: { tabId: string; title: string; domain?: string }[];
  collections: { collectionId: string; name: string; tabCount: number }[];
  note: string;
};

/**
 * Focus as an agent reads it, from the bound snapshot only. `undefined` when
 * there is none — or when nothing it named is still in the workspace.
 *
 * Tab rows need `tabs.read`; without it the agent is told only how many.
 */
export function describeFocus(
  snapshot: SessionContextSnapshot,
  focus: SessionFocus | undefined,
  options: { tabs: boolean }
): (FocusView & { hiddenTabCount?: number }) | undefined {
  if (!focus || isEmptyFocus(focus)) return undefined;
  const byTab = new Map(snapshot.workspace.tabs.map((tab) => [tab.id, tab]));
  const byCollection = new Map(snapshot.collections.map((collection) => [collection.id, collection]));

  const tabs = focus.tabIds.flatMap((tabId) => {
    const tab = byTab.get(tabId);
    if (!tab) return [];
    const domain = sanitizeText(tab.domain);
    return [{ tabId, title: sanitizeText(tab.title) ?? domain ?? "Untitled tab", ...(domain ? { domain } : {}) }];
  });
  const collections = focus.collectionIds.flatMap((collectionId) => {
    const collection = byCollection.get(collectionId);
    if (!collection) return [];
    return [{ collectionId, name: sanitizeText(collection.name) ?? "Untitled collection", tabCount: collection.tabIds.length }];
  });
  if (tabs.length === 0 && collections.length === 0) return undefined;

  return options.tabs
    ? { tabs, collections, note: FOCUS_NOTE }
    : { tabs: [], collections, note: FOCUS_NOTE, hiddenTabCount: tabs.length };
}
