import { describe, expect, it } from "vitest";
import { canonicalSiteIdentity, getDomainSectionName, isGenericSiteIdentity } from "./domain-identity";

describe("canonicalSiteIdentity", () => {
  it("collapses www/m/mobile prefixes to the same identity", () => {
    expect(canonicalSiteIdentity("www.instagram.com")).toBe("instagram.com");
    expect(canonicalSiteIdentity("m.instagram.com")).toBe("instagram.com");
    expect(canonicalSiteIdentity("instagram.com")).toBe("instagram.com");
    expect(canonicalSiteIdentity("mobile.twitter.com")).toBe("twitter.com");
  });

  it("leaves a real product subdomain alone", () => {
    expect(canonicalSiteIdentity("docs.google.com")).toBe("docs.google.com");
    expect(canonicalSiteIdentity("drive.google.com")).toBe("drive.google.com");
    expect(canonicalSiteIdentity("mail.google.com")).toBe("mail.google.com");
  });

  it("collapses Wikipedia's language subdomains", () => {
    expect(canonicalSiteIdentity("en.wikipedia.org")).toBe("wikipedia.org");
    expect(canonicalSiteIdentity("de.wikipedia.org")).toBe("wikipedia.org");
  });

  it("is case-insensitive", () => {
    expect(canonicalSiteIdentity("WWW.Instagram.COM")).toBe("instagram.com");
  });
});

describe("isGenericSiteIdentity", () => {
  it("flags only true springboard search engines", () => {
    expect(isGenericSiteIdentity("google.com")).toBe(true);
    expect(isGenericSiteIdentity("bing.com")).toBe(true);
  });

  it("does not flag real product destinations", () => {
    expect(isGenericSiteIdentity("youtube.com")).toBe(false);
    expect(isGenericSiteIdentity("gmail.com")).toBe(false);
    expect(isGenericSiteIdentity("chatgpt.com")).toBe(false);
    expect(isGenericSiteIdentity("amazon.com")).toBe(false);
    expect(isGenericSiteIdentity("docs.google.com")).toBe(false);
  });
});

describe("getDomainSectionName", () => {
  it("names known brands correctly regardless of host variant", () => {
    expect(getDomainSectionName("www.instagram.com")).toBe("Instagram");
    expect(getDomainSectionName("m.instagram.com")).toBe("Instagram");
    expect(getDomainSectionName("youtube.com")).toBe("YouTube");
    expect(getDomainSectionName("m.youtube.com")).toBe("YouTube");
    expect(getDomainSectionName("reddit.com")).toBe("Reddit");
    expect(getDomainSectionName("old.reddit.com")).toBe("Reddit");
    expect(getDomainSectionName("github.com")).toBe("GitHub");
    expect(getDomainSectionName("notion.so")).toBe("Notion");
    expect(getDomainSectionName("canva.com")).toBe("Canva");
    expect(getDomainSectionName("open.spotify.com")).toBe("Spotify");
    expect(getDomainSectionName("linkedin.com")).toBe("LinkedIn");
    expect(getDomainSectionName("x.com")).toBe("X");
    expect(getDomainSectionName("twitter.com")).toBe("X");
    expect(getDomainSectionName("chatgpt.com")).toBe("ChatGPT");
    expect(getDomainSectionName("chat.openai.com")).toBe("ChatGPT");
  });

  it("distinguishes Google products instead of grouping them all as 'Google'", () => {
    expect(getDomainSectionName("docs.google.com")).toBe("Google Docs");
    expect(getDomainSectionName("drive.google.com")).toBe("Google Drive");
    expect(getDomainSectionName("calendar.google.com")).toBe("Google Calendar");
    expect(getDomainSectionName("mail.google.com")).toBe("Gmail");
    expect(getDomainSectionName("classroom.google.com")).toBe("Google Classroom");
  });

  it("recognizes Amazon across country TLDs", () => {
    expect(getDomainSectionName("www.amazon.in")).toBe("Amazon");
    expect(getDomainSectionName("www.amazon.com")).toBe("Amazon");
    expect(getDomainSectionName("www.amazon.co.uk")).toBe("Amazon");
  });

  it("humanizes an unrecognized domain into a readable, non-ugly name", () => {
    const name = getDomainSectionName("physics-world.example.com");
    expect(name).toBe("Physics World");
    expect(name.toLowerCase()).not.toBe("com");
    expect(name.toLowerCase()).not.toBe("www");
  });

  it("never produces 'Unknown Website' or a bare TLD fragment for a real hostname", () => {
    for (const domain of ["mystrangeblog.dev", "coolsite123.io", "some-tool.app"]) {
      const name = getDomainSectionName(domain);
      expect(name.length).toBeGreaterThan(0);
      expect(["Com", "Www", "Org", "Io", "Dev", "App"]).not.toContain(name);
    }
  });
});
