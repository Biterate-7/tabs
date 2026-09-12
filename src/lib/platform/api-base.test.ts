import { describe, it, expect } from "vitest";
import { apiOrigin, apiUrl } from "./api-base";

/**
 * The value is read from a `process.env.NEXT_PUBLIC_…` member access that
 * Next replaces at build time, so these cases pin the behaviour that ships:
 * unset in every build this repo produces today, and therefore same-origin.
 */
describe("apiUrl", () => {
  it("leaves API paths relative when no origin is configured", () => {
    expect(apiOrigin()).toBe("");
    expect(apiUrl("/api/titles")).toBe("/api/titles");
    expect(apiUrl("/api/auth/me")).toBe("/api/auth/me");
  });

  it("is the identity for every route the app actually calls, so the web build is unchanged", () => {
    const routes = [
      "/api/titles",
      "/api/auth/me",
      "/api/auth/nonce",
      "/api/auth/google",
      "/api/auth/logout",
      "/api/ai/embed",
      "/api/ai/content",
      "/api/ai/organize",
    ];
    for (const route of routes) expect(apiUrl(route)).toBe(route);
  });
});
