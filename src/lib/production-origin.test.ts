import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PRODUCTION_ORIGIN,
  DEV_ORIGIN,
  RETIRED_ORIGINS,
  resolveProductionOrigin,
} from "./production-origin.mjs";

/**
 * The origin every production artifact — the downloadable extension above
 * all — is built against.
 *
 * The incident these tests exist for: the extension ZIP baked in a hardcoded
 * https://tabsdump.vercel.app. That alias was later removed from the Vercel
 * project and began answering 404 DEPLOYMENT_NOT_FOUND, so every "Dump Tabs"
 * skipped the user's real Hubble tab and opened that error page instead.
 */

// What Vercel reports as VERCEL_PROJECT_PRODUCTION_URL for the project.
const PROD_ALIAS = "hubble-hq.vercel.app";
// The project's team alias: live, same deployment, but not canonical.
const TEAM_ALIAS = "tabs-ayaan-viswanathans-projects.vercel.app";
// A per-deployment URL, shaped exactly like the ones Vercel generates.
const DEPLOYMENT_URL = "tabs-gtxma8nys-ayaan-viswanathans-projects.vercel.app";

describe("CANONICAL_PRODUCTION_ORIGIN", () => {
  it("is the Vercel project's production domain", () => {
    expect(CANONICAL_PRODUCTION_ORIGIN).toBe(`https://${PROD_ALIAS}`);
  });

  it("is not the team alias, so local and Vercel builds target the same origin", () => {
    // The extension, sign-in and localStorage are all per-origin: a fallback
    // that differs from VERCEL_PROJECT_PRODUCTION_URL gives a locally built
    // ZIP a different Hubble than the one production serves.
    expect(CANONICAL_PRODUCTION_ORIGIN).not.toBe(`https://${TEAM_ALIAS}`);
  });

  it("is not a retired origin", () => {
    expect(Object.keys(RETIRED_ORIGINS)).not.toContain(CANONICAL_PRODUCTION_ORIGIN);
    expect(CANONICAL_PRODUCTION_ORIGIN).not.toContain("tabsdump");
  });

  it("is not a per-deployment URL, which dies with its deployment", () => {
    // <project>-<9-char hash>-<team>.vercel.app
    expect(new URL(CANONICAL_PRODUCTION_ORIGIN).hostname).not.toMatch(/^tabs-[a-z0-9]{9}-/);
  });

  it("is a bare https origin, usable as a manifest match pattern prefix", () => {
    expect(new URL(CANONICAL_PRODUCTION_ORIGIN).origin).toBe(CANONICAL_PRODUCTION_ORIGIN);
    expect(CANONICAL_PRODUCTION_ORIGIN.startsWith("https://")).toBe(true);
  });
});

describe("RETIRED_ORIGINS", () => {
  it("includes the removed alias that produced DEPLOYMENT_NOT_FOUND, and its lookalike", () => {
    expect(Object.keys(RETIRED_ORIGINS)).toEqual(
      expect.arrayContaining(["https://tabsdump.vercel.app", "https://tabdump.vercel.app"])
    );
  });
});

describe("resolveProductionOrigin", () => {
  it("falls back to the canonical origin with nothing configured", () => {
    expect(resolveProductionOrigin({})).toBe(CANONICAL_PRODUCTION_ORIGIN);
  });

  it("uses Vercel's own production domain on a production build", () => {
    expect(
      resolveProductionOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "hubble.example.com" })
    ).toBe("https://hubble.example.com");
  });

  it("never uses the per-deployment VERCEL_URL on a production build", () => {
    const env = { VERCEL_ENV: "production", VERCEL_URL: DEPLOYMENT_URL };
    expect(resolveProductionOrigin(env)).toBe(CANONICAL_PRODUCTION_ORIGIN);
    expect(resolveProductionOrigin({ ...env, VERCEL_PROJECT_PRODUCTION_URL: PROD_ALIAS })).toBe(`https://${PROD_ALIAS}`);
  });

  it("uses the preview's own URL on a preview build", () => {
    expect(
      resolveProductionOrigin({ VERCEL_ENV: "preview", VERCEL_URL: DEPLOYMENT_URL, VERCEL_PROJECT_PRODUCTION_URL: PROD_ALIAS })
    ).toBe(`https://${DEPLOYMENT_URL}`);
  });

  it("ignores VERCEL_PROJECT_PRODUCTION_URL outside a production build", () => {
    // Vercel exposes it on every environment; a development build that picked
    // it up would quietly point a local ZIP at production.
    expect(resolveProductionOrigin({ VERCEL_ENV: "development", VERCEL_PROJECT_PRODUCTION_URL: "hubble.example.com" })).toBe(
      CANONICAL_PRODUCTION_ORIGIN
    );
  });

  it("lets an explicit override win, normalised to a bare origin", () => {
    expect(resolveProductionOrigin({ TABDUMP_PRODUCTION_ORIGIN: "http://localhost:3000/" })).toBe(DEV_ORIGIN);
    expect(
      resolveProductionOrigin({
        TABDUMP_PRODUCTION_ORIGIN: "https://staging.example.com/some/path",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: PROD_ALIAS,
      })
    ).toBe("https://staging.example.com");
  });

  it.each(Object.keys(RETIRED_ORIGINS))("refuses to resolve to the retired origin %s from any source", (retired) => {
    const host = new URL(retired).host;
    expect(() => resolveProductionOrigin({ TABDUMP_PRODUCTION_ORIGIN: retired })).toThrow(/retired|DEPLOYMENT_NOT_FOUND|unrelated/);
    expect(() => resolveProductionOrigin({ TABDUMP_PRODUCTION_ORIGIN: `${retired}/` })).toThrow();
    expect(() => resolveProductionOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: host })).toThrow();
    expect(() => resolveProductionOrigin({ VERCEL_ENV: "preview", VERCEL_URL: host })).toThrow();
  });

  it("rejects a value that isn't a URL instead of baking it in", () => {
    expect(() => resolveProductionOrigin({ TABDUMP_PRODUCTION_ORIGIN: "https://" })).toThrow(/not a valid URL/);
  });
});

// Every shipped consumer must get the origin from production-origin.mjs rather
// than its own copy — a second copy is exactly how the dead alias outlived the
// domain it named. Tests and this module itself are exempt; docs are not
// shipped.
describe("no retired production origin in shipped source", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const SHIPPED = ["src", "extension", "scripts", "src-tauri/src", "src-tauri/tauri.conf.json", "src-tauri/capabilities", "next.config.ts"];
  const TEXT = /\.(tsx?|jsx?|mjs|css|html|json|rs)$/;

  function* files(entry: string): Generator<string> {
    const full = path.join(ROOT, entry);
    if (!existsSync(full)) return;
    if (statSync(full).isFile()) {
      yield entry;
      return;
    }
    for (const name of readdirSync(full)) {
      if (name === "node_modules" || name === "target") continue;
      yield* files(path.join(entry, name));
    }
  }

  it("names none of RETIRED_ORIGINS outside tests", () => {
    const offenders: string[] = [];
    for (const root of SHIPPED) {
      for (const file of files(root)) {
        if (!TEXT.test(file) || /\.test\.|__fixtures__/.test(file)) continue;
        if (file.endsWith("production-origin.mjs")) continue;
        const text = readFileSync(path.join(ROOT, file), "utf8");
        for (const retired of Object.keys(RETIRED_ORIGINS)) {
          if (text.includes(new URL(retired).host)) offenders.push(`${file}: ${retired}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives the desktop CSP the same production origin", () => {
    const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
    expect(conf.app.security.csp["connect-src"]).toContain(CANONICAL_PRODUCTION_ORIGIN);
  });
});
