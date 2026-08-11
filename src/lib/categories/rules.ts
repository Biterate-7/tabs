import type { CategoryId, UrlContext } from "./types";

export type SignalRule = {
  category: CategoryId;
  score: number;
  label: string;
  test: (ctx: UrlContext) => boolean;
};

const HIGH = 90;
const MEDIUM = 55;
const KEYWORD = 20;

function hostIs(...domains: string[]) {
  return (ctx: UrlContext) =>
    domains.some((d) => ctx.hostname === d || ctx.hostname.endsWith(`.${d}`));
}

function hostIncludes(...fragments: string[]) {
  return (ctx: UrlContext) => fragments.some((f) => ctx.hostname.includes(f));
}

function pathIncludes(...fragments: string[]) {
  return (ctx: UrlContext) =>
    fragments.some((f) => ctx.pathname.includes(f) || ctx.search.includes(f));
}

export const RULES: SignalRule[] = [
  // Research
  {
    category: "research",
    score: HIGH,
    label: "research-high-domain",
    test: hostIs(
      "arxiv.org",
      "scholar.google.com",
      "pubmed.ncbi.nlm.nih.gov",
      "researchgate.net",
      "jstor.org",
      "semanticscholar.org"
    ),
  },
  {
    category: "research",
    score: MEDIUM,
    label: "research-medium-domain",
    test: hostIs("wikipedia.org", "medium.com"),
  },
  {
    category: "research",
    score: MEDIUM,
    label: "research-edu-tld",
    test: (ctx) => ctx.hostname.endsWith(".edu"),
  },
  {
    category: "research",
    score: KEYWORD,
    label: "research-keyword",
    test: pathIncludes("/doi/", "/abs/", "paper", "abstract"),
  },

  // School
  {
    category: "school",
    score: HIGH,
    label: "school-high-domain",
    test: hostIs("classroom.google.com", "blackboard.com", "instructure.com"),
  },
  {
    category: "school",
    score: HIGH,
    label: "school-high-keyword-domain",
    test: hostIncludes("canvas", "moodle"),
  },
  {
    category: "school",
    score: MEDIUM,
    label: "school-medium-domain",
    test: hostIs("docs.google.com", "drive.google.com", "notion.so"),
  },
  {
    category: "school",
    score: KEYWORD,
    label: "school-keyword",
    test: pathIncludes("assignment", "syllabus", "course", "lecture"),
  },

  // Projects
  {
    category: "projects",
    score: HIGH,
    label: "projects-high-domain",
    test: hostIs(
      "github.com",
      "gitlab.com",
      "bitbucket.org",
      "vercel.com",
      "supabase.com",
      "linear.app"
    ),
  },
  {
    category: "projects",
    score: MEDIUM,
    label: "projects-medium-domain",
    test: hostIs("notion.so", "figma.com"),
  },

  // Shopping
  {
    category: "shopping",
    score: HIGH,
    label: "shopping-high-domain",
    test: hostIncludes(
      "amazon.",
      "flipkart.com",
      "myntra.com",
      "ebay.",
      "etsy.com"
    ),
  },
  {
    category: "shopping",
    score: KEYWORD,
    label: "shopping-keyword",
    test: pathIncludes("/cart", "/checkout", "/dp/", "/product/"),
  },

  // Creative
  {
    category: "creative",
    score: HIGH,
    label: "creative-high-domain",
    test: hostIs(
      "canva.com",
      "figma.com",
      "behance.net",
      "dribbble.com",
      "pinterest.com"
    ),
  },

  // News
  {
    category: "news",
    score: HIGH,
    label: "news-high-domain",
    test: hostIs(
      "bbc.com",
      "bbc.co.uk",
      "cnn.com",
      "reuters.com",
      "theguardian.com",
      "nytimes.com",
      "washingtonpost.com",
      "apnews.com",
      "npr.org",
      "bloomberg.com",
      "wsj.com",
      "aljazeera.com",
      "ndtv.com",
      "hindustantimes.com",
      "indianexpress.com",
      "timesofindia.indiatimes.com"
    ),
  },
  {
    category: "news",
    score: KEYWORD,
    label: "news-keyword",
    test: pathIncludes("/news/", "/article/", "/breaking/"),
  },

  // Read Later
  {
    category: "read-later",
    score: MEDIUM,
    label: "read-later-blog-domain",
    test: hostIncludes(
      "substack.com",
      "dev.to",
      "hashnode.com",
      "blogspot.com",
      "wordpress.com"
    ),
  },
  {
    category: "read-later",
    score: KEYWORD,
    label: "read-later-docs-subdomain",
    test: hostIncludes("docs."),
  },
  {
    category: "read-later",
    score: KEYWORD,
    label: "read-later-keyword",
    test: pathIncludes("/blog/", "/posts/", "/article", "/docs/", "/p/"),
  },
];
