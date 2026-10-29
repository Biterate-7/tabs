import type { SiteCategory } from "./types"

/**
 * Which pages context detection may notice — the Hubble page's copy of
 * extension/src/context-sites.js, which is what enforces it. Mirrored rather
 * than imported (the extension has no build step; the same trade-off as
 * lib/browser/protocol.ts), and held together by sites.test.ts.
 *
 * The page uses it to explain the choices in Settings and, as a second line,
 * to refuse any record that should never have been collected.
 */

export const SITE_CATEGORY_HOSTS: Readonly<Record<SiteCategory, readonly string[]>> = {
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
}

export const SITE_CATEGORY_LABEL: Readonly<Record<SiteCategory, { name: string; examples: string }>> = {
  ai: { name: "AI apps", examples: "ChatGPT, Claude, Gemini, Perplexity" },
  docs: { name: "Documents", examples: "Google Docs and Drive, Notion, Overleaf, OneDrive" },
  research: { name: "Research", examples: "Google Scholar, Wikipedia, JSTOR, journals, .edu and .gov sites" },
  video: { name: "Video", examples: "YouTube, Vimeo, TED" },
}

/** Sensitive by nature: never detected. Shown in Settings as what is always skipped. */
export const SENSITIVE_SUMMARY = "Email, messaging and social apps, banking and payments, health portals, password managers, and sign-in, account and checkout pages"

const RESEARCH_SUFFIXES = [".edu", ".ac.uk", ".edu.au", ".ac.nz", ".gov", ".gov.uk", ".int"]

export const SENSITIVE_HOSTS: readonly string[] = [
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
]

const SENSITIVE_HOST_WORDS = /(^|[.-])(bank|banking|onlinebanking|creditunion|paypal|wallet|patient|patientportal|mychart|pharmacy|insurance)([.-]|$)/
const SENSITIVE_PATHS = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(login|log-in|signin|sign-in|signup|sign-up|register|logout|auth|oauth|sso|account|accounts|my-account|settings|preferences|billing|checkout|cart|payment|payments|wallet|password|reset-password|2fa|mfa|verify)(\/|$|\?)/i

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return undefined
  }
}

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export function siteCategoryOf(url: string): SiteCategory | undefined {
  const host = hostOf(url)
  if (!host) return undefined
  for (const category of ["ai", "docs", "research", "video"] as const) {
    if (SITE_CATEGORY_HOSTS[category].some((domain) => hostMatches(host, domain))) return category
  }
  if (RESEARCH_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "research"
  return undefined
}

export function isSensitiveUrl(url: string): boolean {
  const host = hostOf(url)
  if (!host) return true
  if (SENSITIVE_HOSTS.some((domain) => hostMatches(host, domain))) return true
  if (SENSITIVE_HOST_WORDS.test(host)) return true
  try {
    return SENSITIVE_PATHS.test(new URL(url).pathname)
  } catch {
    return true
  }
}

/** A host typed into "Don't detect", reduced to what it is matched by — undefined when it isn't one. */
export function cleanExcludedHost(value: string): string | undefined {
  let text = value.trim().toLowerCase()
  if (!text || text.length > 253) return undefined
  if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`
  const host = hostOf(text)
  if (!host || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host)) return undefined
  return host
}
