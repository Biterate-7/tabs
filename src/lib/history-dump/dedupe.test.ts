import { describe, expect, it } from "vitest";
import { aggregateHistoryEntries } from "./aggregate";
import { buildHistoryCandidates } from "./candidates";
import type { HistoryVisitItem } from "@/lib/browser/protocol";

/**
 * Regression suite for History Dump's canonicalization + deduplication stage
 * (canonical.ts → aggregate.ts → candidates.ts). Every case asserts BOTH the
 * number of logical entities that survive AND which raw entries ended up
 * merged versus kept apart — a count alone would pass just as happily for
 * "merged the wrong two things."
 *
 * Whatever leaves buildHistoryCandidates is what the AI organization pipeline
 * and the graph eventually see, so these are the cases that decide whether a
 * duplicate node can reach the canvas at all.
 */

const NOW = new Date(2026, 0, 31, 12).getTime();
const MINUTE = 60 * 1000;

let seq = 0;
function item(url: string, over: Partial<HistoryVisitItem> = {}): HistoryVisitItem {
  seq += 1;
  return {
    url,
    title: "Page",
    lastVisitTime: NOW - seq * MINUTE,
    visitCount: 1,
    historyItemId: String(seq),
    ...over,
  };
}

/** The logical entities the review UI (and everything downstream of it) would see. */
function entities(items: HistoryVisitItem[]) {
  return buildHistoryCandidates(items, new Set(), NOW).candidates;
}

function urlsOf(items: HistoryVisitItem[]): string[] {
  return entities(items)
    .map((c) => c.url)
    .sort();
}

describe("duplicate history entries collapse into one logical entity", () => {
  it("1. merges exact duplicate urls", () => {
    const result = entities([
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages" }),
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages" }),
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(3);
  });

  it("2. merges the same page carrying different tracking parameters", () => {
    const result = entities([
      item("https://outlook.live.com/mail/0/", { title: "Mail - Ayaan - Outlook" }),
      item("https://outlook.live.com/mail/0/?utm_source=newsletter&utm_campaign=jan", { title: "Mail - Ayaan - Outlook" }),
      item("https://outlook.live.com/mail/0/?fbclid=abc123", { title: "Mail - Ayaan - Outlook" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(3);
  });

  it("3. merges the same context written with different url formatting", () => {
    const result = entities([
      item("http://www.example.com/docs/guide/", { title: "Guide" }),
      item("https://example.com/docs/guide", { title: "Guide" }),
      item("https://www.example.com/docs/guide/index.html#intro", { title: "Guide" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(3);
  });

  it("4. merges equivalent urls that the browser recorded under different titles", () => {
    const result = entities([
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages" }),
      item("https://instagram.com/direct/inbox", { title: "Instagram / Direct" }),
      item("https://www.instagram.com/direct/inbox/?utm_source=push", { title: "Instagram" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(3);
  });

  it("5. collapses a pile of Instagram Messages entries into one entity", () => {
    const result = entities([
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages" }),
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages" }),
      item("https://instagram.com/direct/inbox/", { title: "Instagram / Direct" }),
      item("https://www.instagram.com/direct/inbox/?utm_source=ig_web", { title: "Instagram Messages" }),
      item("https://m.instagram.com/direct/inbox", { title: "Instagram" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(5);
    expect(result[0].domain).toBe("instagram.com");
  });

  it("5b. collapses individual message threads under the same messages context", () => {
    const result = entities([
      item("https://www.instagram.com/direct/t/17954123456789012/", { title: "Instagram" }),
      item("https://www.instagram.com/direct/t/17998877665544332/", { title: "Instagram" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(2);
  });

  it("6. collapses Outlook Mail entries recorded at different depths", () => {
    const result = entities([
      item("https://outlook.live.com/mail/0/", { title: "Mail - Ayaan - Outlook" }),
      item("https://outlook.live.com/mail/0/inbox/id/AAMkADk0NzQyLWQ4Yj/", { title: "Mail - Ayaan - Outlook" }),
      item("https://outlook.live.com/mail/0/?utm_source=email", { title: "Outlook" }),
      item("https://outlook.live.com/mail/0/?nlp=1", { title: "Mail - Ayaan - Outlook" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(4);
  });

  it("6b. merges one page carrying view state the other lacks", () => {
    const result = entities([
      item("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { title: "Never Gonna Give You Up - YouTube" }),
      item("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&si=abc", { title: "Never Gonna Give You Up - YouTube" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(2);
  });

  it("6c. merges the mobile rendering of a page with its desktop one", () => {
    const result = entities([
      item("https://en.wikipedia.org/wiki/Photosynthesis", { title: "Photosynthesis - Wikipedia" }),
      item("https://en.m.wikipedia.org/wiki/Photosynthesis", { title: "Photosynthesis - Wikipedia" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrenceCount).toBe(2);
  });
});

describe("genuinely different pages stay separate entities", () => {
  it("7. keeps Instagram Messages, Profile and Explore apart", () => {
    const items = [
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages" }),
      item("https://www.instagram.com/nasa/", { title: "NASA (@nasa) • Instagram" }),
      item("https://www.instagram.com/explore/", { title: "Explore • Instagram" }),
    ];
    expect(urlsOf(items)).toEqual([
      "https://www.instagram.com/direct/inbox/",
      "https://www.instagram.com/explore/",
      "https://www.instagram.com/nasa/",
    ]);
  });

  it("8. keeps Outlook Mail and Outlook Calendar apart", () => {
    const items = [
      item("https://outlook.live.com/mail/0/", { title: "Mail - Ayaan - Outlook" }),
      item("https://outlook.live.com/calendar/0/view/month", { title: "Calendar - Ayaan - Outlook" }),
    ];
    expect(urlsOf(items)).toEqual([
      "https://outlook.live.com/calendar/0/view/month",
      "https://outlook.live.com/mail/0/",
    ]);
  });

  it("8b. keeps a site's home page apart from a page inside it", () => {
    const items = [
      item("https://www.youtube.com/", { title: "YouTube" }),
      item("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { title: "Never Gonna Give You Up - YouTube" }),
    ];
    expect(urlsOf(items)).toEqual(["https://www.youtube.com/", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  });

  it("8c. keeps two items in the same context apart when their content differs", () => {
    const items = [
      item("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { title: "Never Gonna Give You Up" }),
      item("https://www.youtube.com/watch?v=9bZkp7q19f0", { title: "Gangnam Style" }),
      item("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit", { title: "Project Plan" }),
      item("https://docs.google.com/document/d/9ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit", { title: "Budget Review" }),
    ];
    expect(entities(items)).toHaveLength(4);
  });

  it("8d. keeps a nested page apart from its parent when it names different content", () => {
    const items = [
      item("https://github.com/vercel/next.js", { title: "GitHub - vercel/next.js" }),
      item("https://github.com/vercel/next.js/pull/12345", { title: "Fix hydration mismatch · Pull Request #12345" }),
    ];
    expect(entities(items)).toHaveLength(2);
  });

  it("9. keeps different meaningful paths on one domain apart", () => {
    const items = [
      item("https://example.com/docs/getting-started", { title: "Getting Started" }),
      item("https://example.com/pricing", { title: "Pricing" }),
      item("https://example.com/blog/why-we-built-it", { title: "Why We Built It" }),
    ];
    expect(entities(items)).toHaveLength(3);
  });

  it("9b. never merges a search engine with a product on a related domain", () => {
    // Goes through aggregate directly: buildHistoryCandidates drops search
    // result pages as noise before dedup ever sees them.
    const result = aggregateHistoryEntries([
      item("https://www.google.com/search?q=react+hooks", { title: "react hooks - Google Search" }),
      item("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit", { title: "Project Plan" }),
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("10. a mixed dump of duplicates and distinct pages", () => {
  const items = [
    item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages", lastVisitTime: NOW - 1 * MINUTE }),
    item("https://instagram.com/direct/inbox", { title: "Instagram / Direct", lastVisitTime: NOW - 30 * MINUTE }),
    item("https://www.instagram.com/direct/inbox/?utm_source=ig_web", { title: "Instagram", lastVisitTime: NOW - 60 * MINUTE }),
    item("https://www.instagram.com/explore/", { title: "Explore • Instagram" }),
    item("https://www.instagram.com/nasa/", { title: "NASA (@nasa) • Instagram" }),
    item("https://outlook.live.com/mail/0/", { title: "Mail - Ayaan - Outlook" }),
    item("https://outlook.live.com/mail/0/inbox/id/AAMkADk0NzQyLWQ4Yj/", { title: "Mail - Ayaan - Outlook" }),
    item("https://outlook.live.com/calendar/0/view/month", { title: "Calendar - Ayaan - Outlook" }),
    item("https://www.youtube.com/", { title: "YouTube" }),
    item("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { title: "Never Gonna Give You Up - YouTube" }),
    item("https://en.wikipedia.org/wiki/Photosynthesis", { title: "Photosynthesis - Wikipedia" }),
    item("https://en.wikipedia.org/wiki/Photosynthesis?utm_source=share", { title: "Photosynthesis - Wikipedia" }),
    item("https://en.wikipedia.org/wiki/Mitochondrion", { title: "Mitochondrion - Wikipedia" }),
  ];

  it("yields exactly one entity per logical page", () => {
    expect(items).toHaveLength(13);
    expect(entities(items)).toHaveLength(9);
  });

  it("merges only the duplicate representations, and keeps every distinct page", () => {
    const byOccurrences = new Map(entities(items).map((c) => [c.url, c.occurrenceCount]));
    expect(byOccurrences.get("https://www.instagram.com/direct/inbox/")).toBe(3);
    expect(byOccurrences.get("https://outlook.live.com/mail/0/")).toBe(2);
    expect(byOccurrences.get("https://en.wikipedia.org/wiki/Photosynthesis")).toBe(2);
    expect(byOccurrences.get("https://www.instagram.com/explore/")).toBe(1);
    expect(byOccurrences.get("https://www.instagram.com/nasa/")).toBe(1);
    expect(byOccurrences.get("https://outlook.live.com/calendar/0/view/month")).toBe(1);
    expect(byOccurrences.get("https://www.youtube.com/")).toBe(1);
    expect(byOccurrences.get("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(1);
    expect(byOccurrences.get("https://en.wikipedia.org/wiki/Mitochondrion")).toBe(1);
  });

  it("gives every entity a distinct canonical identity", () => {
    const keys = entities(items).map((c) => c.canonicalKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("deduplication preserves the underlying history", () => {
  it("keeps every raw entry behind the entity it folded into, newest first", () => {
    const raw = [
      item("https://www.instagram.com/direct/inbox/", { title: "Instagram Messages", lastVisitTime: NOW - 5 * MINUTE, visitCount: 4 }),
      item("https://instagram.com/direct/inbox", { title: "Instagram / Direct", lastVisitTime: NOW - 1 * MINUTE, visitCount: 3 }),
      item("https://www.instagram.com/direct/inbox/?utm_source=x", { title: "Instagram", lastVisitTime: NOW - 90 * MINUTE, visitCount: 1 }),
    ];
    const [entity] = entities(raw);

    expect(entity.occurrenceCount).toBe(3);
    expect(entity.occurrences.map((o) => o.historyItemId)).toEqual([raw[1], raw[0], raw[2]].map((o) => o.historyItemId));
    expect(entity.visitCount).toBe(8);
    expect(entity.lastVisitedAt).toBe(NOW - 1 * MINUTE);
  });

  it("represents the entity with its most recent occurrence", () => {
    const [entity] = entities([
      item("https://outlook.live.com/mail/0/", { title: "Outlook", lastVisitTime: NOW - 3 * 60 * MINUTE }),
      item("https://outlook.live.com/mail/0/inbox/id/AAMkADk0NzQyLWQ4Yj/", { title: "Mail - Ayaan - Outlook", lastVisitTime: NOW - 2 * MINUTE }),
    ]);
    expect(entity.url).toBe("https://outlook.live.com/mail/0/inbox/id/AAMkADk0NzQyLWQ4Yj/");
    expect(entity.title).toBe("Mail - Ayaan - Outlook");
  });

  it("reports how many history entries were folded together", () => {
    const [entity] = entities([
      item("https://example.com/docs/guide"),
      item("https://www.example.com/docs/guide/"),
    ]);
    expect(entity.reasons).toContain("Merged 2 history entries");
  });

  it("says nothing about merging when a page appeared only once", () => {
    const [entity] = entities([item("https://example.com/docs/guide")]);
    expect(entity.reasons.some((r) => r.startsWith("Merged"))).toBe(false);
  });
});

describe("candidates already saved in the workspace", () => {
  it("recognizes a saved tab through a tracking-param variant in history", () => {
    const result = buildHistoryCandidates(
      [item("https://www.example.com/docs/guide/?utm_source=news", { title: "Guide" })],
      new Set(["https://example.com/docs/guide"]),
      NOW
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].alreadyInWorkspace).toBe(true);
  });

  it("still does not flag a page the workspace does not have", () => {
    const result = buildHistoryCandidates(
      [item("https://www.example.com/docs/guide", { title: "Guide" })],
      new Set(["https://example.com/pricing"]),
      NOW
    );
    expect(result.candidates[0].alreadyInWorkspace).toBe(false);
  });
});
