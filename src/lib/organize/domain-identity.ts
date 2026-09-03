/**
 * Canonical site identity + deterministic section naming for domain-based
 * clustering (AGENTS.md's "domain clustering as a HARD organizational
 * signal"). Kept separate from keywords.ts because this is about WHICH site
 * a URL belongs to (independent of any tab's title), not about extracting
 * topic tokens from text.
 */

const MOBILE_PREFIXES = new Set(["www", "m", "mobile", "amp", "touch"]);

/**
 * Collapses host variants that are the same site to one identity key:
 * `www.instagram.com` / `m.instagram.com` / `instagram.com` all become
 * `instagram.com`. A real PRODUCT subdomain (`docs.google.com`,
 * `mail.google.com`, ...) is deliberately left alone — only a generic
 * mobile/www-style prefix is stripped, never a subdomain that identifies a
 * distinct product.
 */
export function canonicalSiteIdentity(rawDomain: string): string {
  const lower = rawDomain.trim().toLowerCase().replace(/\.$/, "");
  const labels = lower.split(".");
  if (labels.length > 2 && MOBILE_PREFIXES.has(labels[0])) {
    labels.shift();
  }
  // Wikipedia's per-language subdomains (en., simple., de., ...) are the same
  // "site" for clustering purposes — collapse them the same way www/m are.
  if (labels.length === 3 && labels[1] === "wikipedia" && labels[2] === "org" && labels[0].length <= 3) {
    return "wikipedia.org";
  }
  return labels.join(".");
}

/**
 * Hosts whose canonical identity is too generic to ever drive a domain-only
 * cluster on its own — a shared "google.com" or "bing.com" tells you nothing
 * about topic, since these are springboards to arbitrary unrelated
 * destinations rather than a product/destination in themselves. Deliberately
 * NOT applied to product subdomains (docs.google.com etc.) or to genuine
 * destination sites (youtube.com, gmail.com, chatgpt.com, amazon.com, ...) —
 * those ARE the product, so a cluster of them is real signal.
 */
const GENERIC_SITE_IDENTITIES = new Set(["google.com", "bing.com", "duckduckgo.com"]);

export function isGenericSiteIdentity(identity: string): boolean {
  return GENERIC_SITE_IDENTITIES.has(identity);
}

/** Canonical identity → human display name, for sites whose brand name isn't a trivial capitalization of their domain label. */
const BRAND_NAMES: Record<string, string> = {
  "instagram.com": "Instagram",
  "youtube.com": "YouTube",
  "reddit.com": "Reddit",
  "old.reddit.com": "Reddit",
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
  "bitbucket.org": "Bitbucket",
  "stackoverflow.com": "Stack Overflow",
  "notion.so": "Notion",
  "canva.com": "Canva",
  "figma.com": "Figma",
  "open.spotify.com": "Spotify",
  "spotify.com": "Spotify",
  "linkedin.com": "LinkedIn",
  "x.com": "X",
  "twitter.com": "X",
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "openai.com": "OpenAI",
  "gmail.com": "Gmail",
  "mail.google.com": "Gmail",
  "docs.google.com": "Google Docs",
  "drive.google.com": "Google Drive",
  "calendar.google.com": "Google Calendar",
  "classroom.google.com": "Google Classroom",
  "sheets.google.com": "Google Sheets",
  "slides.google.com": "Google Slides",
  "forms.google.com": "Google Forms",
  "meet.google.com": "Google Meet",
  "maps.google.com": "Google Maps",
  "translate.google.com": "Google Translate",
  "photos.google.com": "Google Photos",
  "scholar.google.com": "Google Scholar",
  "tiktok.com": "TikTok",
  "facebook.com": "Facebook",
  "pinterest.com": "Pinterest",
  "netflix.com": "Netflix",
  "twitch.tv": "Twitch",
  "discord.com": "Discord",
  "wikipedia.org": "Wikipedia",
  "outlook.com": "Outlook",
  "outlook.office.com": "Outlook",
  "outlook.live.com": "Outlook",
  "vercel.com": "Vercel",
  "supabase.com": "Supabase",
  "npmjs.com": "npm",
  "developer.mozilla.org": "MDN",
  "arxiv.org": "arXiv",
};

/** Amazon's many country TLDs (amazon.com, amazon.in, amazon.co.uk, ...) all mean the same product identity. */
function isAmazon(identity: string): boolean {
  return /(^|\.)amazon\.[a-z.]+$/.test(identity);
}

/** TLD-like trailing labels stripped before humanizing an unrecognized domain's brand label — same spirit as keywords.ts's domainTokens. */
const TLD_SUFFIX = /\.(com|org|net|io|co|edu|gov|dev|app|ai|so|tv|me|xyz|in|uk|example)$/i;

/** Title-cases a single dash/underscore-delimited label, e.g. "physics-world" -> "Physics World". A label with no delimiters (e.g. "physicsworld") stays one capitalized word — there's no dictionary to split it further. */
function humanizeLabel(label: string): string {
  const words = label.split(/[-_]+/).filter(Boolean);
  return words.map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
}

/**
 * Deterministic, human-readable section name for a domain cluster — never
 * invented by the AI (AGENTS.md §4). Known brands use their real name;
 * anything else is derived from the hostname's main label so it's never
 * "Com", "WWW", or "Unknown Website".
 */
export function getDomainSectionName(domain: string): string {
  const identity = canonicalSiteIdentity(domain);
  if (BRAND_NAMES[identity]) return BRAND_NAMES[identity];
  if (isAmazon(identity)) return "Amazon";

  const withoutTld = identity.replace(TLD_SUFFIX, "");
  const labels = withoutTld.split(".").filter(Boolean);
  // Prefer the most specific (leftmost) label that isn't just another TLD-ish
  // remnant — for an unrecognized "physicsworld.example.com" this picks
  // "physicsworld" over "example".
  const mainLabel = labels.find((l) => l.length >= 2) ?? labels[0] ?? identity;
  const humanized = humanizeLabel(mainLabel);
  return humanized || "Unclassified Site";
}
