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
 *   liveCheck   what Hubble's own automated QA did on the vendor's live site,
 *               under which conditions and when — a dated observation (for
 *               example signed out, in Chrome), not a person's verification,
 *               and never a promise that the site still works that way.
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
  /** What automated QA saw on the live site, with its conditions and date. */
  liveCheck?: string;
};

export type ProviderCapabilities = {
  /** Save the open conversation from Hubble for Chrome — only when the person asks. */
  pageCapture: ProviderCapability;
  /** Import the provider's own data-export file. */
  exportImport: ProviderCapability;
  /** Paste a conversation or excerpt into Hubble. */
  paste: ProviderCapability;
  /** Put chosen Hubble context into the provider's message box (Use in AI, and the extension popup). */
  insert: ProviderCapability;
  /** Attach an uploaded file's original (a PDF, a Word document…) to the message, as the person would. */
  attachFiles: ProviderCapability;
  /** Press the provider's own send button after inserting — only when the person turned it on for that transfer. */
  autoSubmit: ProviderCapability;
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
   * Paths of the page that starts a new conversation. A tab already on one
   * can take a transfer (when its message box is empty); a tab inside a
   * conversation is never written into — context is never added to a chat
   * the person didn't choose.
   */
  newChatPaths: readonly RegExp[];
  /** Hubble's own bounds for one Use in AI transfer to this app — not the vendor's published limits. */
  transfer: {
    /** Characters Hubble will type into the message box. Past this, the person chooses something smaller or a file. */
    messageChars: number;
    /** Files attached to one message. */
    maxFiles: number;
  };
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
  "Use in AI (with Hubble for Chrome) opens a new chat and types the chosen context into its message box; it checks the text arrived before saying so. A message box that already holds a draft is never overwritten. Without the extension, Hubble copies the text and opens the app for you to paste.";
const ATTACH_NOTE =
  "Use in AI can attach an uploaded file's original to the message, the way choosing it from the app's attach button would, and checks the app shows it. If the app doesn't take it, Hubble says so and puts the file's text in instead — never claiming the original was attached.";
const LIVE_SIGNED_OUT = "Driven by Hubble's QA on the live site, signed out, in Chrome, 2026-10-19:";
const SUBMIT_NOTE =
  "Off unless you choose Send automatically for that transfer. Hubble presses the app's own send button once the message (and any file) is ready, and reports sent only when the message box has emptied.";

export const AI_PROVIDERS: Readonly<Record<AiProviderId, AiProvider>> = {
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    vendor: "OpenAI",
    hosts: ["chatgpt.com", "chat.openai.com"],
    homeUrl: "https://chatgpt.com/",
    newChatPaths: [/^\/$/],
    transfer: { messageChars: 60_000, maxFiles: 10 },
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
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE, liveCheck: `${LIVE_SIGNED_OUT} typed into a new chat (its plain message box, signed out) and read back; a draft in an open tab was left alone and a new tab used instead.` },
      attachFiles: { supported: true, verified: "fixture", note: ATTACH_NOTE, liveCheck: `${LIVE_SIGNED_OUT} ChatGPT took the file from its file input and asked to log in to upload, so Hubble reported it not attached and typed the text version. Attaching while signed in has not been checked.` },
      autoSubmit: { supported: true, verified: "fixture", note: SUBMIT_NOTE, liveCheck: `${LIVE_SIGNED_OUT} sent a test message and saw the message box empty and the chat open.` },
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
    newChatPaths: [/^\/new\/?$/],
    transfer: { messageChars: 60_000, maxFiles: 10 },
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
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE, liveCheck: "Not checked on the live site: signed out, claude.ai sends a new chat to its sign-in page (with a human check Hubble never touches), which Hubble reports as sign-in required." },
      attachFiles: { supported: true, verified: "fixture", note: ATTACH_NOTE },
      autoSubmit: { supported: true, verified: "fixture", note: SUBMIT_NOTE },
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
    newChatPaths: [/^\/app\/?$/],
    transfer: { messageChars: 30_000, maxFiles: 10 },
    conversationPaths: [/^\/app\/([A-Za-z0-9_-]{6,80})\/?$/, /^\/gem\/[^/]+\/([A-Za-z0-9_-]{6,80})\/?$/, /^\/share\/([A-Za-z0-9_-]{6,80})\/?$/],
    capabilities: {
      pageCapture: { supported: true, verified: "fixture", note: CAPTURE_NOTE },
      exportImport: {
        supported: false,
        verified: "none",
        note: "Not available: Google Takeout exports Gemini activity, not conversations Hubble can read reliably. Save each conversation from the page, or paste it.",
      },
      paste: PASTE,
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE, liveCheck: `${LIVE_SIGNED_OUT} typed into a new chat (Quill editor) with its line breaks, and read back.` },
      attachFiles: { supported: true, verified: "fixture", note: ATTACH_NOTE, liveCheck: `${LIVE_SIGNED_OUT} Gemini did not show a pasted or dropped file, so Hubble reported it not attached and typed the text version. Attaching while signed in has not been checked.` },
      autoSubmit: { supported: true, verified: "fixture", note: SUBMIT_NOTE, liveCheck: `${LIVE_SIGNED_OUT} sent a test message and saw the message box empty.` },
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
    newChatPaths: [/^\/$/],
    transfer: { messageChars: 15_000, maxFiles: 10 },
    conversationPaths: [/^\/search\/([A-Za-z0-9._-]{6,200})\/?$/],
    capabilities: {
      pageCapture: { supported: true, verified: "fixture", note: CAPTURE_NOTE },
      exportImport: {
        supported: false,
        verified: "none",
        note: "Not available: Perplexity has no account export. A thread's own Export → Markdown can be imported as a Markdown file or pasted.",
      },
      paste: PASTE,
      insert: { supported: true, verified: "fixture", note: INSERT_NOTE, liveCheck: `${LIVE_SIGNED_OUT} typed into a new thread (Lexical editor) with its line breaks, and read back.` },
      attachFiles: { supported: true, verified: "fixture", note: ATTACH_NOTE, liveCheck: `${LIVE_SIGNED_OUT} Perplexity took the file from its file input and asked to sign in to upload, so Hubble reported it not attached and typed the text version. Attaching while signed in has not been checked.` },
      autoSubmit: { supported: true, verified: "fixture", note: SUBMIT_NOTE, liveCheck: `${LIVE_SIGNED_OUT} sent a test message and saw the thread open.` },
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

/** Whether this address is the page where `provider` starts a new conversation. */
export function isNewChatUrl(provider: AiProviderId, url: string): boolean {
  const parsed = parse(url);
  if (!parsed || parsed.protocol !== "https:" || !AI_PROVIDERS[provider].hosts.includes(parsed.hostname.toLowerCase())) return false;
  return AI_PROVIDERS[provider].newChatPaths.some((pattern) => pattern.test(parsed.pathname));
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
