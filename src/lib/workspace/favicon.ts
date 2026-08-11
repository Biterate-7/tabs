const PALETTE = [
  "--category-research",
  "--category-school",
  "--category-projects",
  "--category-shopping",
  "--category-creative",
  "--category-news",
  "--category-read-later",
  "--category-other",
];

export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}

export function avatarFallback(domain: string): { letter: string; colorVar: string } {
  if (!domain) return { letter: "?", colorVar: PALETTE[PALETTE.length - 1] };

  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }

  return {
    letter: domain[0].toUpperCase(),
    colorVar: PALETTE[hash % PALETTE.length],
  };
}
