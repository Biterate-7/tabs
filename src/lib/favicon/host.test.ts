import { describe, expect, it } from "vitest";
import { faviconHostKey } from "./host";

describe("faviconHostKey", () => {
  it("keeps every subdomain label — a subdomain is its own site", () => {
    expect(faviconHostKey("console.cloud.google.com")).toBe("console.cloud.google.com");
    expect(faviconHostKey("cloud.google.com")).toBe("cloud.google.com");
    expect(faviconHostKey("console.cloud.google.com")).not.toBe(faviconHostKey("cloud.google.com"));
  });

  it("accepts Hubble's own production host", () => {
    expect(faviconHostKey("hubble-hq.vercel.app")).toBe("hubble-hq.vercel.app");
  });

  it("normalises case, whitespace and a trailing root dot to one key", () => {
    expect(faviconHostKey("  GitHub.COM. ")).toBe("github.com");
    expect(faviconHostKey("github.com")).toBe(faviconHostKey("GITHUB.com"));
  });

  it("accepts punycode (what URL.hostname gives for IDNs)", () => {
    expect(faviconHostKey("xn--bcher-kva.example.org")).toBe("xn--bcher-kva.example.org");
  });

  it("asks nothing for reserved or local-only names", () => {
    for (const host of [
      "docs.hubble.example",
      "app.test",
      "nothing.invalid",
      "localhost",
      "api.localhost",
      "printer.local",
      "metadata.google.internal",
      "router.lan",
      "nas.home.arpa",
      "hidden.onion",
    ]) {
      expect(faviconHostKey(host), host).toBeNull();
    }
    // Only the reserved top-level names, not look-alikes inside a real name.
    expect(faviconHostKey("example.com")).toBe("example.com");
    expect(faviconHostKey("testing.io")).toBe("testing.io");
  });

  it("refuses IP literals and malformed input", () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "[::1]", "::1", "intranet", "", "a..b", "-bad.com", "bad-.com", "has space.com", "evil.com/path", "user@evil.com"]) {
      expect(faviconHostKey(host), host).toBeNull();
    }
    expect(faviconHostKey(undefined)).toBeNull();
    expect(faviconHostKey(42)).toBeNull();
    expect(faviconHostKey(`${"a".repeat(250)}.com`)).toBeNull();
  });
});
