import { describe, expect, it } from "vitest";
import {
  areTitlesEquivalent,
  canonicalizeHistoryUrl,
  canonicalizeTitle,
  duplicateConfidence,
  looksLikeOpaqueId,
  shareCanonicalContext,
} from "./canonical";

function identity(url: string) {
  const result = canonicalizeHistoryUrl(url);
  if (!result) throw new Error(`expected ${url} to canonicalize`);
  return result;
}

function entry(url: string, title?: string) {
  const id = identity(url);
  return { identity: id, title: canonicalizeTitle(title, id.siteIdentity) };
}

describe("canonicalizeHistoryUrl", () => {
  it("collapses protocol, www/m prefixes and trailing slashes into one key", () => {
    const keys = [
      "https://www.instagram.com/direct/inbox/",
      "http://instagram.com/direct/inbox",
      "https://m.instagram.com/direct/inbox/",
    ].map((url) => identity(url).key);
    expect(new Set(keys).size).toBe(1);
  });

  it("strips tracking, analytics and session parameters", () => {
    const bare = identity("https://outlook.live.com/mail/0/").key;
    expect(identity("https://outlook.live.com/mail/0/?utm_source=news&utm_campaign=x").key).toBe(bare);
    expect(identity("https://outlook.live.com/mail/0/?fbclid=abc&igshid=def").key).toBe(bare);
    expect(identity("https://outlook.live.com/mail/0/?sessionid=99&ref=email").key).toBe(bare);
  });

  it("keeps parameters that actually select content", () => {
    expect(identity("https://www.youtube.com/watch?v=aaa").key).not.toBe(
      identity("https://www.youtube.com/watch?v=bbb").key
    );
  });

  it("collapses a mobile rendering of a host, wherever the label sits", () => {
    expect(identity("https://en.m.wikipedia.org/wiki/Photosynthesis").key).toBe(
      identity("https://en.wikipedia.org/wiki/Photosynthesis").key
    );
    expect(identity("https://m.example.com/docs").key).toBe(identity("https://www.example.com/docs").key);
  });

  it("leaves a product subdomain alone", () => {
    expect(identity("https://docs.google.com/document/d/x").siteIdentity).toBe("docs.google.com");
    expect(identity("https://mail.google.com/mail/u/0").siteIdentity).toBe("mail.google.com");
  });

  it("ignores fragments and directory index filenames", () => {
    const bare = identity("https://example.com/docs/guide").key;
    expect(identity("https://example.com/docs/guide/#section-2").key).toBe(bare);
    expect(identity("https://example.com/docs/guide/index.html").key).toBe(bare);
  });

  it("never reduces a url to its bare domain", () => {
    expect(identity("https://instagram.com/direct").key).not.toBe(identity("https://instagram.com/explore").key);
    expect(identity("https://instagram.com/direct").key).not.toBe(identity("https://instagram.com/").key);
  });

  it("returns null for non-http(s) urls", () => {
    expect(canonicalizeHistoryUrl("chrome://settings")).toBeNull();
    expect(canonicalizeHistoryUrl("not a url")).toBeNull();
  });
});

describe("looksLikeOpaqueId", () => {
  it("treats numeric, hash and opaque token segments as identifiers", () => {
    expect(looksLikeOpaqueId("0")).toBe(true);
    expect(looksLikeOpaqueId("17954123456789012")).toBe(true);
    expect(looksLikeOpaqueId("a1b2c3d4e5f6")).toBe(true);
    expect(looksLikeOpaqueId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(looksLikeOpaqueId("AAMkADk0NzQyLWQ4Yj")).toBe(true);
  });

  it("never treats a word slug as an identifier", () => {
    expect(looksLikeOpaqueId("inbox")).toBe(false);
    expect(looksLikeOpaqueId("why-is-the-sky-blue")).toBe(false);
    expect(looksLikeOpaqueId("random-old-page")).toBe(false);
    expect(looksLikeOpaqueId("quantum_mechanics")).toBe(false);
    expect(looksLikeOpaqueId("2026-budget-review")).toBe(false);
  });
});

describe("context paths", () => {
  it("stops at the first opaque segment so per-item urls share their context", () => {
    expect(identity("https://outlook.live.com/mail/0/").contextSegments).toEqual(["mail"]);
    expect(identity("https://outlook.live.com/mail/0/inbox/id/AAMkADk0NzQyLWQ4Yj/").contextSegments).toEqual(["mail"]);
    expect(identity("https://outlook.live.com/calendar/0/view/month").contextSegments).toEqual(["calendar"]);
  });

  it("keeps meaningful segments intact", () => {
    expect(identity("https://www.instagram.com/direct/inbox/").contextSegments).toEqual(["direct", "inbox"]);
    expect(identity("https://en.wikipedia.org/wiki/Photosynthesis").contextSegments).toEqual(["wiki", "photosynthesis"]);
  });
});

describe("canonicalizeTitle", () => {
  it("flattens separator styles to the same text", () => {
    const site = "instagram.com";
    const variants = ["Instagram Messages", "Instagram — Messages", "Instagram | Messages", "Instagram / Messages"];
    const texts = variants.map((t) => canonicalizeTitle(t, site).text);
    expect(new Set(texts).size).toBe(1);
  });

  it("drops notification counters", () => {
    expect(canonicalizeTitle("(12) Instagram Messages", "instagram.com").text).toBe(
      canonicalizeTitle("Instagram Messages", "instagram.com").text
    );
  });

  it("drops the site's own brand words from the comparison tokens", () => {
    expect(canonicalizeTitle("Instagram Messages", "instagram.com").tokens).toEqual(["messages"]);
    expect(canonicalizeTitle("Instagram", "instagram.com").tokens).toEqual([]);
  });
});

describe("areTitlesEquivalent", () => {
  it("treats a brand-only or blank title as carrying no distinguishing information", () => {
    const brandOnly = canonicalizeTitle("Instagram", "instagram.com");
    const blank = canonicalizeTitle(undefined, "instagram.com");
    const named = canonicalizeTitle("Instagram Messages", "instagram.com");
    expect(areTitlesEquivalent(brandOnly, named)).toBe(true);
    expect(areTitlesEquivalent(blank, named)).toBe(true);
  });

  it("keeps genuinely different page names apart", () => {
    const mail = canonicalizeTitle("Mail - Ayaan - Outlook", "outlook.live.com");
    const calendar = canonicalizeTitle("Calendar - Ayaan - Outlook", "outlook.live.com");
    expect(areTitlesEquivalent(mail, calendar)).toBe(false);
  });
});

describe("shareCanonicalContext", () => {
  it("is false across different services", () => {
    expect(
      shareCanonicalContext(identity("https://docs.google.com/document/d/x"), identity("https://www.google.com/search"))
    ).toBe(false);
  });

  it("is false for different contexts on one service", () => {
    expect(
      shareCanonicalContext(identity("https://outlook.live.com/mail/0/"), identity("https://outlook.live.com/calendar/0/"))
    ).toBe(false);
    expect(
      shareCanonicalContext(identity("https://instagram.com/direct/inbox"), identity("https://instagram.com/explore"))
    ).toBe(false);
  });

  it("is false when the two urls disagree about a parameter they both carry", () => {
    expect(
      shareCanonicalContext(
        identity("https://www.youtube.com/watch?v=aaa"),
        identity("https://www.youtube.com/watch?v=bbb&t=42s")
      )
    ).toBe(false);
  });

  it("is true when the extra parameter is only on one side", () => {
    expect(
      shareCanonicalContext(
        identity("https://www.youtube.com/watch?v=aaa"),
        identity("https://www.youtube.com/watch?v=aaa&t=42s")
      )
    ).toBe(true);
    expect(
      shareCanonicalContext(identity("https://outlook.live.com/mail/0/"), identity("https://outlook.live.com/mail/0/?nlp=1"))
    ).toBe(true);
  });

  it("never lets a site's root page absorb its subpages", () => {
    expect(shareCanonicalContext(identity("https://www.youtube.com/"), identity("https://www.youtube.com/watch?v=a"))).toBe(
      false
    );
  });
});

describe("duplicateConfidence", () => {
  it("reports high confidence for one page reached two ways", () => {
    expect(
      duplicateConfidence(
        entry("https://www.instagram.com/direct/inbox/", "Instagram Messages"),
        entry("http://instagram.com/direct/inbox?utm_source=x", "Instagram / Direct")
      )
    ).toBe("high");
  });

  it("reports medium confidence for one context reached at different depths", () => {
    expect(
      duplicateConfidence(
        entry("https://outlook.live.com/mail/0/", "Mail - Ayaan - Outlook"),
        entry("https://outlook.live.com/mail/0/inbox/id/AAMkADk0NzQyLWQ4Yj/", "Mail - Ayaan - Outlook")
      )
    ).toBe("medium");
  });

  it("reports none when only the domain is shared", () => {
    expect(
      duplicateConfidence(
        entry("https://outlook.live.com/mail/0/", "Mail - Ayaan - Outlook"),
        entry("https://outlook.live.com/calendar/0/view/month", "Calendar - Ayaan - Outlook")
      )
    ).toBe("none");
    expect(
      duplicateConfidence(
        entry("https://www.instagram.com/direct/inbox/", "Instagram Messages"),
        entry("https://www.instagram.com/nasa/", "NASA on Instagram")
      )
    ).toBe("none");
  });

  it("does not merge same-context items that name different content", () => {
    expect(
      duplicateConfidence(
        entry("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit", "Project Plan"),
        entry("https://docs.google.com/document/d/9ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit", "Budget Review")
      )
    ).toBe("none");
  });
});
