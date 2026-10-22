import { faviconHostKey } from "@/lib/favicon/host";
import { readPageIcon } from "@/lib/favicon/page-icon";
import { providerOfUrl } from "@/lib/providers/registry";
import type { AiProviderId } from "@/lib/providers/registry";
import { itemKind } from "./kinds";
import type { KnowledgeItem } from "./items";

/**
 * What an item is recognised by at a glance, wherever it is listed: the AI
 * app it came from, the site it lives on, or — only when it has neither —
 * the glyph for its kind.
 *
 *   provider  an AI conversation from an app Hubble knows (ChatGPT, Claude,
 *             Gemini, Perplexity): that app's own logo
 *   site      anything with a web address (a page, a video, a repository, a
 *             PDF link, a saved tab): the icon that site declares
 *   glyph     a file uploaded from this device, the person's own note or
 *             excerpt, anything with no address that can be trusted
 *
 * Only the host ever leaves the device — the favicon resolver is asked by
 * `?host=`, never by the page's address — so a page's path and query
 * (tokens, search terms) are not sent anywhere to draw its icon.
 */
export type ItemIdentity =
  | { kind: "provider"; provider: AiProviderId }
  | { kind: "site"; host: string; icon?: string }
  | { kind: "glyph" };

/**
 * Hosts that are the same site under another name, so they draw that site's
 * icon: a short link or a mobile host serves a redirect or a stripped page,
 * not the icon people know.
 */
const SITE_ALIASES: Readonly<Record<string, string>> = {
  "youtu.be": "youtube.com",
  "m.youtube.com": "youtube.com",
  "m.wikipedia.org": "wikipedia.org",
  "mobile.twitter.com": "twitter.com",
  "mobile.x.com": "x.com",
};

/** The host whose icon stands for an address, or undefined for one that has none worth asking for. */
export function siteHostOf(url: string | undefined, domain?: string): string | undefined {
  let host = domain?.trim().toLowerCase();
  if (!host && url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
      host = parsed.hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  if (!host) return undefined;
  host = host.replace(/^www\./, "");
  const key = faviconHostKey(SITE_ALIASES[host] ?? host);
  return key ?? undefined;
}

/** The icon Chrome showed for a saved tab's page, if the item is one: the caller's tab record, looked up by the item's ref. */
export function pageIconOf(workspace: { tabs: readonly { id: string; favicon?: string }[] }, item: Pick<KnowledgeItem, "ref">): string | undefined {
  const ref = item.ref;
  if (ref.kind !== "source") return undefined;
  return workspace.tabs.find((tab) => tab.id === ref.tabId)?.favicon;
}

export function itemIdentity(
  item: Pick<KnowledgeItem, "type" | "url" | "domain" | "provider" | "fileName" | "ref">,
  /** The icon Chrome itself showed for this page (`Tab.favicon`), when the item is a saved tab. */
  pageIcon?: string
): ItemIdentity {
  const kind = itemKind(item);
  if (kind === "file" || kind === "note") return { kind: "glyph" };
  const provider = item.provider ?? (kind === "conversation" && item.url ? providerOfUrl(item.url) : undefined);
  if (provider) return { kind: "provider", provider };
  const host = siteHostOf(item.url, item.domain);
  if (!host) return { kind: "glyph" };
  const icon = readPageIcon(pageIcon);
  return { kind: "site", host, ...(icon ? { icon } : {}) };
}
