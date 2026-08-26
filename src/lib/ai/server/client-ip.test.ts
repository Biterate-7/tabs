import { describe, expect, it } from "vitest";
import { getClientIp } from "./client-ip";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://tabdump.example/api/ai/embed", { headers });
}

describe("getClientIp", () => {
  it("reads a single x-forwarded-for value", () => {
    expect(getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("takes the first (client) entry from a multi-hop x-forwarded-for chain", () => {
    expect(getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.5, 10.0.0.1, 10.0.0.2" }))).toBe(
      "203.0.113.5"
    );
  });

  it("handles an IPv6 address", () => {
    expect(getClientIp(requestWithHeaders({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(getClientIp(requestWithHeaders({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("prefers x-forwarded-for over x-real-ip when both are present", () => {
    expect(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.5", "x-real-ip": "198.51.100.9" }))
    ).toBe("203.0.113.5");
  });

  it("returns 'unknown' when neither header is present (e.g. local dev with no proxy in front)", () => {
    expect(getClientIp(requestWithHeaders({}))).toBe("unknown");
  });

  it("returns 'unknown' rather than an empty string for a blank header", () => {
    expect(getClientIp(requestWithHeaders({ "x-forwarded-for": "" }))).toBe("unknown");
  });
});
