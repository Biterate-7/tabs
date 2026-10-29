// Pure logic only — no `chrome.*` calls in this file (same discipline as
// tabs.js / browser-commands.js), so every rule about WHICH pages context
// detection may notice is unit tested without mocking Chrome.
//
// src/lib/intelligence/sites.ts mirrors the lists below for the Hubble page
// (Settings explains them, and the page re-checks what it is handed);
// src/lib/intelligence/sites.test.ts holds the two together.
//
// The rules, in order — the first that applies wins:
//   1. Never: anything but an ordinary http(s) page, Hubble itself, this
//      computer (localhost, private addresses), and pages that are sensitive
//      by nature — mail, messaging, banking and payments, health portals,
//      sign-in and account pages. Their titles alone can carry an email
//      subject or a message, so not even the title is kept.
//   2. Never: a host the person excluded (and its subdomains).
//   3. Mode "off": nothing. Mode "sites": only the categories chosen.
//      Mode "auto": everything not excluded above.

import { aiProviderOf, conversationIdentityOf } from "./ai-pages.js";

export const SITE_CATEGORY_HOSTS = Object.freeze({
  ai: ["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "perplexity.ai"],
  docs: ["docs.google.com", "drive.google.com", "notion.so", "overleaf.com", "onedrive.live.com", "sharepoint.com", "dropbox.com", "quip.com", "coda.io"],
  research: [
    "scholar.google.com",
    "wikipedia.org",
    "britannica.com",
    "jstor.org",
    "arxiv.org",
    "pubmed.ncbi.nlm.nih.gov",
    "ncbi.nlm.nih.gov",
    "researchgate.net",
    "sciencedirect.com",
    "springer.com",
    "nature.com",
    "tandfonline.com",
    "wiley.com",
    "semanticscholar.org",
    "khanacademy.org",
    "investopedia.com",
    "tutor2u.net",
    "economicshelp.org",
    "brookings.edu",
    "oecd.org",
    "worldbank.org",
    "imf.org",
    "who.int",
    "ourworldindata.org",
    "bbc.co.uk",
    "theguardian.com",
    "economist.com",
    "ft.com",
    "nytimes.com",
    "reuters.com",
    "apnews.com",
  ],
  video: ["youtube.com", "youtu.be", "vimeo.com", "ted.com"],
});

/** Academic and public-sector hosts count as research wherever they are. */
const RESEARCH_SUFFIXES = [".edu", ".ac.uk", ".edu.au", ".ac.nz", ".gov", ".gov.uk", ".int"];

/** Sensitive by nature: never detected, in any mode. Matched against the host and its parent domains. */
export const SENSITIVE_HOSTS = Object.freeze([
  "mail.google.com",
  "inbox.google.com",
  "contacts.google.com",
  "calendar.google.com",
  "accounts.google.com",
  "myaccount.google.com",
  "pay.google.com",
  "passwords.google.com",
  "photos.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.proton.me",
  "proton.me",
  "icloud.com",
  "fastmail.com",
  "web.whatsapp.com",
  "whatsapp.com",
  "messenger.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "snapchat.com",
  "discord.com",
  "slack.com",
  "teams.microsoft.com",
  "telegram.org",
  "web.telegram.org",
  "signal.org",
  "linkedin.com",
  "tinder.com",
  "bumble.com",
  "paypal.com",
  "venmo.com",
  "wise.com",
  "revolut.com",
  "monzo.com",
  "stripe.com",
  "coinbase.com",
  "binance.com",
  "robinhood.com",
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "citi.com",
  "capitalone.com",
  "americanexpress.com",
  "hsbc.com",
  "barclays.co.uk",
  "lloydsbank.com",
  "natwest.com",
  "santander.co.uk",
  "mychart.org",
  "nhs.uk",
  "1password.com",
  "lastpass.com",
  "bitwarden.com",
  "dashlane.com",
  "okta.com",
  "auth0.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
]);

/** A host that names banking, payment or health anywhere in it ("mybank.co.uk", "healthportal.example"). */
const SENSITIVE_HOST_WORDS = /(^|[.-])(bank|banking|onlinebanking|creditunion|paypal|wallet|patient|patientportal|mychart|pharmacy|insurance)([.-]|$)/;

/** Sign-in, account, payment and settings pages on any site: what they show is about the person, not their work. */
const SENSITIVE_PATHS = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(login|log-in|signin|sign-in|signup|sign-up|register|logout|auth|oauth|sso|account|accounts|my-account|settings|preferences|billing|checkout|cart|payment|payments|wallet|password|reset-password|2fa|mfa|verify)(\/|$|\?)/i;

function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Whether `host` is `domain` or one of its subdomains. */
export function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isLocalHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || host === "0.0.0.0") return true;
  const private172 = /^172\.(\d+)\./.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  return host.startsWith("[") || host === "::1";
}

/** The category a host belongs to, or undefined for "any other site". */
export function siteCategoryOf(url) {
  const host = hostOf(url);
  if (!host) return undefined;
  for (const category of ["ai", "docs", "research", "video"]) {
    if (SITE_CATEGORY_HOSTS[category].some((domain) => hostMatches(host, domain))) return category;
  }
  if (RESEARCH_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "research";
  return undefined;
}

/** Sensitive by nature (rule 1): never detected, in any mode, whatever the person chose. */
export function isSensitiveUrl(url) {
  const host = hostOf(url);
  if (!host) return true;
  if (SENSITIVE_HOSTS.some((domain) => hostMatches(host, domain))) return true;
  if (SENSITIVE_HOST_WORDS.test(host)) return true;
  let path = "/";
  try {
    path = new URL(url).pathname;
  } catch {
    return true;
  }
  return SENSITIVE_PATHS.test(path);
}

/** A host the person typed into "Don't detect", reduced to what it is matched by — or undefined when it isn't one. */
export function cleanExcludedHost(value) {
  if (typeof value !== "string") return undefined;
  let text = value.trim().toLowerCase();
  if (!text || text.length > 253) return undefined;
  if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`;
  const host = hostOf(text);
  if (!host || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host)) return undefined;
  return host;
}

/**
 * Whether context detection may notice this page at all, under `settings`.
 * `hubbleOrigin` is never detected (the person's own Hubble tabs).
 *
 * @param {string} url
 * @param {{ mode?: string, paused?: boolean, pausedUntil?: number, excludedHosts?: string[], categories?: string[] } | undefined} settings
 * @param {{ hubbleOrigin?: string, now?: number }} [options]
 */
export function isDetectable(url, settings, { hubbleOrigin, now = Date.now() } = {}) {
  if (!settings || settings.mode === "off") return false;
  if (settings.paused && !(Number.isFinite(settings.pausedUntil) && settings.pausedUntil <= now)) return false;
  const host = hostOf(url);
  if (!host || isLocalHost(host)) return false;
  try {
    if (hubbleOrigin && new URL(url).origin === hubbleOrigin) return false;
  } catch {
    return false;
  }
  if (isSensitiveUrl(url)) return false;
  if ((settings.excludedHosts ?? []).some((domain) => hostMatches(host, domain))) return false;
  if (settings.mode === "sites") {
    const category = siteCategoryOf(url);
    return category !== undefined && (settings.categories ?? []).includes(category);
  }
  return settings.mode === "auto";
}

/** What kind of thing the page is, from its address alone. */
export function activityKindOf(url) {
  if (conversationIdentityOf(url)) return "conversation";
  const host = hostOf(url) ?? "";
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = "";
  }
  if (/\.pdf$/.test(path)) return "pdf";
  if (["docs.google.com", "notion.so", "overleaf.com", "onedrive.live.com", "sharepoint.com", "quip.com", "coda.io"].some((domain) => hostMatches(host, domain))) return "document";
  if (["youtube.com", "youtu.be", "vimeo.com", "ted.com"].some((domain) => hostMatches(host, domain))) return "video";
  if (siteCategoryOf(url) === "research") return "article";
  return "webpage";
}

const TRACKING = /^(utm_.+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src|ref_url|spm|si)$/i;

/**
 * One page's identity for de-duplicating events: a conversation by which
 * conversation it is, a YouTube video by its id, anything else by its
 * address without fragment, tracking parameters, www/http or a trailing
 * slash. Coarse on purpose — the Hubble page re-keys every record with its
 * own `sourceKey` (src/lib/resources/url.ts) and merges any that agree there.
 */
export function activityKeyOf(url) {
  const conversation = conversationIdentityOf(url);
  if (conversation) return `conversation:${conversation.key}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host === "youtu.be" && parsed.pathname.length > 1) return `youtube:${parsed.pathname.slice(1).split("/")[0]}`;
  if (hostMatches(host, "youtube.com") && parsed.pathname === "/watch" && parsed.searchParams.get("v")) return `youtube:${parsed.searchParams.get("v")}`;
  const params = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING.test(name)).sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const port = parsed.port && parsed.port !== "80" && parsed.port !== "443" ? `:${parsed.port}` : "";
  return `${host}${port}${parsed.pathname.replace(/\/+$/, "")}${query}`;
}

export { aiProviderOf };
