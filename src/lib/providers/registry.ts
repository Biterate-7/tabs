/**
 * The AI apps Hubble remembers conversations from — as data.
 *
 * Hubble is the knowledge layer *across* the AI apps a person already uses.
 * This registry is the one place that says which apps those are, how to
 * recognise one of their conversations by its address, and — honestly — what
 * Hubble can and cannot do with each.
 *
 * ## Capabilities are claims, so each one says how it is known
 *
 *   supported   whether Hubble implements this path at all
 *   verified    how it was exercised:
 *                 "fixture"   Hubble's tests drove it against saved,
 *                             representative page or file fixtures — not the
 *                             live product, whose pages change without notice
 *                 "protocol"  driven over the real wire format with the
 *                             official SDK client, not the vendor's app
 *                 "none"      not exercised (so not offered)
 *
 * Nothing here is "live" until a person has done it against the real
 * product; the Settings page shows this field rather than a green tick.
 *
 * ## What is deliberately absent
 *
 * No account sign-in, no cookies, no private endpoints. Hubble never reads a
 * provider account: it saves the conversation open in front of the person,
 * when they ask, or a file they exported themselves.
 */

export type AiProviderId = "chatgpt" | "claude" | "gemini" | "perplexity";

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ["chatgpt", "claude", "gemini", "perplexity"] as const;

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export type CapabilityVerification = "fixture" | "protocol" | "none";

export type ProviderCapability = {
  supported: boolean;
  verified: CapabilityVerification;
  /** One sentence a person can read: what happens, or why not. */
  note: string;
};

export type ProviderCapabilities = {
  /** Save the open conversation from Hubble for Chrome — only when the person asks. */
  pageCapture: ProviderCapability;
  /** Import the provider's own data-export file. */
  exportImport: ProviderCapability;
  /** Paste a conversation or excerpt into Hubble. */
  paste: ProviderCapability;
  /** Put chosen Hubble context into the provider's message box, never sending it. */
  insert: ProviderCapability;
  /** The provider's app reads Hubble through an MCP connector (Settings → AI integrations). */
  connector: ProviderCapability;
  /** Keep a saved conversation up to date without the person saving it again. */
  autoSync: ProviderCapability;
};

export type AiProvider = {
  id: AiProviderId;
  /** What the person calls it. */
  name: string;
  vendor: string;
  /** Hostnames whose pages are this provider's app. Exact matches. */
  hosts: readonly string[];
  /** Where a new conversation starts. */
  homeUrl: string;
  /**
   * Path patterns of one conversation (or thread), first capture group = its id.
   * Anything else on the host (settings, the home page, a library) is not a conversation.
   */
  conversationPaths: readonly RegExp[];
  /** Which export file `exportImport` reads, in the vendor's words. */
  exportFile?: string;
  capabilities: ProviderCapabilities;
};

const PASTE: ProviderCapability = {
  supported: true,
  verified: "fixture",
  note: "Paste the conversation (or part of it) and Hubble saves it as text, split into turns when it can tell who said what.",
};

const NO_SYNC: ProviderCapability = {
  supported: false,
  verified: "none",
  note: "Not available. Save the conversation again to bring in what was added since — Hubble updates the saved copy instead of adding a second one.",
};

const CAPTURE_NOTE =
  "Open the conversation and use Save to Hubble in Hubble for Chrome. Hubble reads only what is on that page, when you ask.";
const INSERT_NOTE =
  "Hubble for Chrome can type chosen context into the message box. It never presses send — you review it first. If the box can't be found, it copies instead and says so.";

export const AI_PROVIDERS: Readonly<Record<AiProviderId, AiProvider>> = {
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    vendor: "OpenAI",
    hosts: ["chatgpt.com", "chat.openai.com"],
    homeUrl: "https://chatgpt.com/",
    // /uc/ is a signed-out conversation (seen live 2026-10-14).
    conversationPaths: [/^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9-]{8,80})\/?$/, /^\/uc\/([A-Za-z0-9-]{8,80})\/?$/, /^\/share\/([A-Za-z0-9-]{8,80})\/?$/],
    exportFile: "conversations.json from ChatGPT's data export (Settings → Data controls → Export data)",
    capabilities: {
      pageCapture: { supported: true, verified: "fixture", note: CAPTURE_NOTE },
      exportImport: {
        supported: true,
        verified: "fixture",
        note: "Import conversations.json from ChatGPT's own data export. Each conversation becomes one saved conversation, linked to its original address.",
      },
      paste: PASTE,
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE },
      connector: {
        supported: true,
        verified: "protocol",
        note: "ChatGPT can read (and, if you allow it, save to) your synced Hubble projects through an MCP connector — see AI integrations.",
      },
      autoSync: NO_SYNC,
    },
  },
  claude: {
    id: "claude",
    name: "Claude",
    vendor: "Anthropic",
    hosts: ["claude.ai"],
    homeUrl: "https://claude.ai/new",
    conversationPaths: [/^\/chat\/([A-Za-z0-9-]{8,80})\/?$/, /^\/share\/([A-Za-z0-9-]{8,80})\/?$/],
    exportFile: "conversations.json from Claude's data export (Settings → Privacy → Export data)",
    capabilities: {
      pageCapture: { supported: true, verified: "fixture", note: CAPTURE_NOTE },
      exportImport: {
        supported: true,
        verified: "fixture",
        note: "Import conversations.json from Claude's own data export. Each conversation becomes one saved conversation, linked to its original address.",
      },
      paste: PASTE,
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE },
      connector: {
        supported: true,
        verified: "protocol",
        note: "Claude can read (and, if you allow it, save to) your synced Hubble projects through a custom connector — see AI integrations.",
      },
      autoSync: NO_SYNC,
    },
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    vendor: "Google",
    hosts: ["gemini.google.com"],
    homeUrl: "https://gemini.google.com/app",
    conversationPaths: [/^\/app\/([A-Za-z0-9_-]{6,80})\/?$/, /^\/gem\/[^/]+\/([A-Za-z0-9_-]{6,80})\/?$/, /^\/share\/([A-Za-z0-9_-]{6,80})\/?$/],
    capabilities: {
      pageCapture: { supported: true, verified: "fixture", note: CAPTURE_NOTE },
      exportImport: {
        supported: false,
        verified: "none",
        note: "Not available: Google Takeout exports Gemini activity, not conversations Hubble can read reliably. Save each conversation from the page, or paste it.",
      },
      paste: PASTE,
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE },
      connector: {
        supported: true,
        verified: "protocol",
        note: "The Gemini app can read your synced Hubble projects as a custom app where Google offers it (see AI integrations for the requirements).",
      },
      autoSync: NO_SYNC,
    },
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    vendor: "Perplexity",
    hosts: ["www.perplexity.ai", "perplexity.ai"],
    homeUrl: "https://www.perplexity.ai/",
    conversationPaths: [/^\/search\/([A-Za-z0-9._-]{6,200})\/?$/],
    capabilities: {
      pageCapture: { supported: true, verified: "fixture", note: CAPTURE_NOTE },
      exportImport: {
        supported: false,
        verified: "none",
        note: "Not available: Perplexity has no account export. A thread's own Export → Markdown can be imported as a Markdown file or pasted.",
      },
      paste: PASTE,
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE },
      connector: {
        supported: false,
        verified: "none",
        note: "Not available: Hubble has no tested way for Perplexity to read it. Copy context from Hubble instead.",
      },
      autoSync: NO_SYNC,
    },
  },
};

export function aiProvider(id: AiProviderId): AiProvider {
  return AI_PROVIDERS[id];
}

/** "ChatGPT" for a known id; "AI" otherwise. */
export function aiProviderName(id: string | null | undefined): string {
  return isAiProviderId(id) ? AI_PROVIDERS[id].name : "AI";
}

function parse(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The provider whose app this address belongs to — any page of it, conversation or not. */
export function providerOfUrl(url: string): AiProviderId | undefined {
  const parsed = parse(url);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase();
  return AI_PROVIDER_IDS.find((id) => AI_PROVIDERS[id].hosts.includes(host));
}

export type ConversationRef = {
  provider: AiProviderId;
  /** The provider's own id for the conversation, from its address. */
  conversationId: string;
  /** The address without query or fragment — what Hubble keys a saved conversation on. */
  url: string;
};

/**
 * The conversation an address names, or `undefined` when it names none (a
 * provider's home page, settings, another site).
 */
export function conversationRefOf(url: string): ConversationRef | undefined {
  const parsed = parse(url);
  if (!parsed) return undefined;
  const provider = providerOfUrl(url);
  if (!provider) return undefined;
  for (const pattern of AI_PROVIDERS[provider].conversationPaths) {
    const match = pattern.exec(parsed.pathname);
    if (match?.[1]) {
      return { provider, conversationId: match[1], url: `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}` };
    }
  }
  return undefined;
}

/**
 * The canonical address of a conversation from a provider's export, built
 * from the id the export itself carries. It opens the conversation for its
 * owner while it still exists; Hubble says so rather than promising it.
 */
export function conversationUrlFor(provider: AiProviderId, conversationId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(conversationId)) return undefined;
  if (provider === "chatgpt") return `https://chatgpt.com/c/${conversationId}`;
  if (provider === "claude") return `https://claude.ai/chat/${conversationId}`;
  if (provider === "gemini") return `https://gemini.google.com/app/${conversationId}`;
  return undefined;
}
