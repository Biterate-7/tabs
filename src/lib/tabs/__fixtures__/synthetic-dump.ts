import type { Tab } from "../types";

/**
 * A large synthetic dump used to stress-test the categorization pipeline the
 * way a real ~580-tab dump does (see AGENTS.md's reported failure: 580 tabs
 * in, 444 landing in "Other"). Not a real user's data — built from a handful
 * of realistic topic templates, each repeated with varied titles/domains and
 * deliberately shuffled so tabs from the same topic land far apart in dump
 * order, the exact condition that broke the old fixed-size-chunk pipeline
 * (a topic split across chunk boundaries looked like several uncorroborated
 * singletons instead of one cluster).
 */
type Topic = { domains: string[]; titles: string[]; category: Tab["category"] };

const TOPICS: Topic[] = [
  {
    category: "school",
    domains: ["khanacademy.org", "arxiv.org", "en.wikipedia.org", "cern.ch", "wolframalpha.com"],
    titles: [
      "Schwarzschild radius derivation",
      "Black holes and general relativity",
      "S2 star orbit around Sagittarius A*",
      "Curved spacetime and geodesics",
      "Photoelectric effect and quantum theory",
      "Special relativity time dilation",
      "Newtonian mechanics problem set",
      "Kepler's laws of planetary orbits",
      "Gravitational wave detection - LIGO",
      "Physics IA - orbital simulation in Python",
      "Electromagnetic induction and Faraday's law",
      "Entropy and the second law of thermodynamics",
    ],
  },
  {
    category: "school",
    domains: ["lse.ac.uk", "investopedia.com", "en.wikipedia.org", "imf.org", "worldbank.org"],
    titles: [
      "IB Economics Paper 1 revision questions",
      "LSE seminar on economic growth models",
      "Why does inflation erode purchasing power",
      "Aggregate demand and market equilibrium",
      "Price elasticity of demand calculations",
      "How fiscal and monetary policy differ",
      "How GDP is calculated across countries",
      "Comparative advantage and international trade",
      "Fixed and floating exchange regimes compared",
      "Structural and cyclical unemployment",
    ],
  },
  {
    category: "school",
    domains: ["history.com", "en.wikipedia.org", "bbc.co.uk", "jstor.org"],
    titles: [
      "Causes of the First World War",
      "Terms of the Treaty of Versailles",
      "Trench warfare on the Western Front",
      "Assassination of Archduke Franz Ferdinand",
      "The alliance system before 1914",
      "Europe between the wars 1919-1939",
    ],
  },
  {
    category: "projects",
    domains: ["github.com", "stackoverflow.com", "nextjs.org", "vercel.com", "developer.mozilla.org"],
    titles: [
      "react-hook-form issue #4213",
      "Next.js App Router routing conventions",
      "Diagnosing a hydration mismatch in React",
      "TypeScript generics for reusable components",
      "Vercel deployment build failing on install",
      "TabDump repository - main branch",
      "useEffect cleanup function patterns",
      "Choosing CSS grid over flexbox",
      "React Server Components data fetching",
      "Configuring a custom Tailwind CSS theme",
      "Setting up a GitHub Actions CI pipeline",
      "Tracking down a memory leak in Node.js",
    ],
  },
  {
    category: "creative",
    domains: ["helpx.adobe.com", "youtube.com", "figma.com", "canva.com"],
    titles: [
      "Keyframing pans and zooms in Premiere Pro",
      "Color grading a short piece in Premiere",
      "Building kinetic titles in After Effects",
      "Figma constraints for responsive frames",
      "Non-destructive layer masks in Photoshop",
      "Pacing cuts for a YouTube video edit",
      "Designing a poster template in Canva",
      "Adding whip pan transitions in Premiere",
    ],
  },
  {
    category: "research",
    domains: ["tradingview.com", "bloomberg.com", "reuters.com", "ft.com"],
    titles: [
      "S&P 500 candlestick pattern today",
      "Markets steady following the Federal Reserve meeting",
      "TradingView chart setup - AAPL daily",
      "Bloomberg terminal markets wrap",
      "What rising bond yields signal for stocks",
      "Oil prices climb on supply concerns",
      "Why tech stocks sold off this week",
    ],
  },
  {
    category: "other",
    domains: ["instagram.com", "twitter.com", "reddit.com", "tiktok.com"],
    titles: [
      "Instagram profile - a friend's trip photos",
      "Reddit thread in r/programming",
      "A post about AI on Twitter",
      "TikTok clip - a quick cooking trick",
    ],
  },
  {
    category: "shopping",
    domains: ["amazon.com", "ebay.com", "etsy.com"],
    titles: [
      "Amazon listing - wireless mouse",
      "eBay auction - vintage rangefinder camera",
      "Etsy shop - handmade leather desk mat",
    ],
  },
];

function shuffled<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Builds `count` tabs (default ~580, matching the reported failure case)
 * spread across TOPICS, cycling through each topic's titles/domains with an
 * index suffix once exhausted (so a large count still produces distinct
 * titles/URLs), then shuffles the whole set so same-topic tabs land far
 * apart — the exact ordering that defeated the old fixed-size-chunk pipeline.
 */
export function buildSyntheticDump(count = 580): Tab[] {
  const perTopic = Math.ceil(count / TOPICS.length);
  const tabs: Tab[] = [];
  let id = 0;

  for (const topic of TOPICS) {
    for (let i = 0; i < perTopic; i++) {
      const title = topic.titles[i % topic.titles.length];
      const domain = topic.domains[i % topic.domains.length];
      const suffix = i >= topic.titles.length ? ` (${Math.floor(i / topic.titles.length) + 1})` : "";
      id++;
      const url = `https://${domain}/${encodeURIComponent(title.toLowerCase().replace(/\s+/g, "-"))}-${id}`;
      tabs.push({
        id: `synthetic-${id}`,
        url,
        normalizedUrl: url,
        domain,
        category: topic.category,
        title: `${title}${suffix}`,
      });
      if (tabs.length >= count) return shuffled(tabs, 42);
    }
  }
  return shuffled(tabs.slice(0, count), 42);
}
