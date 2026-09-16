import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_PRODUCTION_ORIGIN as EXTENSION_ORIGIN } from "../../scripts/build-extension-zip.mjs";
import { CANONICAL_PRODUCTION_ORIGIN, siteOrigin, siteUrl } from "./site-url";

/**
 * The origin this deployment claims to live at.
 *
 * The one test worth having here is the cross-check against the extension
 * build: the site's canonical URL and the extension's host permissions
 * describing different origins is the kind of mismatch nobody notices until
 * sign-in or a dump quietly stops working in production. The constant is
 * duplicated between the two on purpose (one is a plain .mjs run by Node
 * outside the Next build graph), so something has to hold them together.
 */

const ENV_KEYS = ["TABDUMP_PRODUCTION_ORIGIN", "VERCEL_ENV", "VERCEL_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("siteOrigin", () => {
  it("agrees with the origin the extension is built against", () => {
    expect(CANONICAL_PRODUCTION_ORIGIN).toBe(EXTENSION_ORIGIN);
    expect(CANONICAL_PRODUCTION_ORIGIN).toBe("https://tabsdump.vercel.app");
  });

  it("falls back to the canonical origin when nothing is configured", () => {
    clearEnv();
    expect(siteOrigin()).toBe(CANONICAL_PRODUCTION_ORIGIN);
  });

  it("prefers an explicit override, trailing slash removed", () => {
    clearEnv();
    process.env.TABDUMP_PRODUCTION_ORIGIN = "http://localhost:3000/";
    expect(siteOrigin()).toBe("http://localhost:3000");
  });

  it("uses Vercel's per-deployment URL on a preview", () => {
    clearEnv();
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "tabdump-abc123.vercel.app";
    expect(siteOrigin()).toBe("https://tabdump-abc123.vercel.app");
  });

  it("ignores VERCEL_URL outside a preview", () => {
    // A production deployment's VERCEL_URL is the auto-generated per-deployment
    // host, not the domain anyone visits — canonicalising to it would point
    // every shared link at a URL that changes on the next deploy.
    clearEnv();
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_URL = "tabdump-xyz789.vercel.app";
    expect(siteOrigin()).toBe(CANONICAL_PRODUCTION_ORIGIN);
  });

  it("lets an explicit override win over a preview URL", () => {
    clearEnv();
    process.env.TABDUMP_PRODUCTION_ORIGIN = "https://staging.example.com";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "tabdump-abc123.vercel.app";
    expect(siteOrigin()).toBe("https://staging.example.com");
  });
});

describe("siteUrl", () => {
  it("builds absolute URLs on the resolved origin", () => {
    clearEnv();
    expect(siteUrl("/welcome")).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/welcome`);
    expect(siteUrl()).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/`);
  });
});
