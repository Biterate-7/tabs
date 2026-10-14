import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveContext } from "./resolve";
import { fixtureWorld, scopeA, T0 } from "./__fixtures__/world";
import type { ContextRequest, ContextSnapshot } from "./types";
import type { ContextWorld } from "./world";

/**
 * The context resolver's structural guards.
 *
 * The resolver describes a person's knowledge to readers that leave the page
 * — above all the MCP tools that answer ChatGPT, Claude or Gemini. Its
 * failures are silent: a resolver that leaked another account's project
 * would return a plausible-looking snapshot. So this suite asserts, from
 * the files themselves and through the resolver, that it reads only the
 * world it is handed, for the owner and the projects it is asked about, and
 * that nothing it returns can carry a credential.
 */

const CONTEXT_DIR = path.resolve(__dirname);
const SRC_DIR = path.resolve(__dirname, "../../..");
const REPO_ROOT = path.resolve(SRC_DIR, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__fixtures__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const contextSources = walk(CONTEXT_DIR).map((file) => ({
  file: path.relative(REPO_ROOT, file),
  name: path.basename(file),
  source: readFileSync(file, "utf8"),
}));

/** Code lines only — prose legitimately discusses what is deliberately not done. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function importsOf(source: string): string[] {
  return [
    ...source.matchAll(/^\s*import\s[^\n]*?["']([^"']+)["']/gm),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function resolveOrThrow(
  request: ContextRequest,
  world: ContextWorld = fixtureWorld()
): ContextSnapshot {
  const result = resolveContext(request, world, {
    now: () => T0,
    createSnapshotId: () => "snap",
  });
  if (!result.ok) throw new Error(`expected resolution, got ${result.reason}`);
  return result.snapshot;
}

describe("the resolver reaches nothing it should not", () => {
  it("finds the files it is supposed to be checking", () => {
    expect(contextSources.length).toBeGreaterThanOrEqual(5);
    const names = contextSources.map((entry) => entry.name);
    expect(names).toContain("resolve.ts");
    expect(names).toContain("types.ts");
    expect(names).toContain("sanitize.ts");
  });

  it("imports no persistence module", () => {
    // The bridge is handed a world. If it could load one, then anything
    // holding a resolver would transitively hold the whole store.
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      for (const specifier of importsOf(source)) {
        if (/persistence|\/storage\/|namespace/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("touches no browser storage, cookie or credential API", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      const code = codeOf(source);
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "document.cookie",
        "navigator.credentials",
        "caches.",
      ]) {
        if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("performs no network or filesystem access", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      const code = codeOf(source);
      for (const forbidden of ["fetch(", "XMLHttpRequest", "WebSocket", "child_process", "node:fs"]) {
        if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
      for (const specifier of importsOf(source)) {
        if (/^node:/.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scrapes no page — nothing here reads a DOM or a document body", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      const code = codeOf(source);
      for (const forbidden of [
        "document.querySelector",
        "innerHTML",
        "innerText",
        "textContent",
        "DOMParser",
        "chrome.tabs",
        "chrome.scripting",
      ]) {
        if (code.includes(forbidden)) offenders.push(`${file}: ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no credential field", () => {
    const offenders: string[] = [];
    for (const { file, source } of contextSources) {
      for (const pattern of [
        /\b(apiKey|accessToken|refreshToken|clientSecret|password|cookie|bearer|authHeader)\s*[?:]/i,
      ]) {
        if (pattern.test(codeOf(source))) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

});

describe("cross-account isolation", () => {
  it("refuses a scope whose owner is not the world's owner", () => {
    const result = resolveContext(
      { scope: scopeA("user-2"), sources: ["tab"], workspaceIds: ["ws-a"] },
      fixtureWorld("user-1"),
      { now: () => T0, createSnapshotId: () => "snap" }
    );

    expect(result).toEqual({ ok: false, reason: "owner-mismatch" });
  });

  it("refuses signed-out content against a signed-in scope, and the reverse", () => {
    const signedOutWorld = fixtureWorld(null);

    expect(
      resolveContext(
        { scope: scopeA("user-1"), sources: ["tab"], workspaceIds: ["ws-a"] },
        signedOutWorld,
        { now: () => T0, createSnapshotId: () => "s" }
      )
    ).toEqual({ ok: false, reason: "owner-mismatch" });

    expect(
      resolveContext(
        { scope: scopeA(null), sources: ["tab"], workspaceIds: ["ws-a"] },
        fixtureWorld("user-1"),
        { now: () => T0, createSnapshotId: () => "s" }
      )
    ).toEqual({ ok: false, reason: "owner-mismatch" });
  });

  it("an id alone is never enough — the same ids fail under the wrong owner", () => {
    // Both accounts hold a workspace called ws-a. Only the matching owner
    // resolves, which is the whole point: Hubble's partition is applied at
    // load, so the resolver has to re-check it rather than trust the id.
    const mine = resolveOrThrow(
      { scope: scopeA("user-1"), sources: ["tab"], workspaceIds: ["ws-a"] },
      fixtureWorld("user-1")
    );
    expect(mine.items.length).toBeGreaterThan(0);

    expect(
      resolveContext(
        { scope: scopeA("user-1"), sources: ["tab"], workspaceIds: ["ws-a"] },
        fixtureWorld("user-2"),
        { now: () => T0, createSnapshotId: () => "s" }
      )
    ).toEqual({ ok: false, reason: "owner-mismatch" });
  });
});

describe("cross-workspace isolation", () => {
  it("a request for workspace A contains nothing from workspace B", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["workspace", "tab", "collection", "relationship", "graph"],
      workspaceIds: ["ws-a"],
      collectionIds: ["col-a1", "col-b1"],
      tabIds: ["b1", "b2"],
      graph: { centerTabIds: ["a1"], depth: 3 },
    });

    const serialized = JSON.stringify(snapshot.items);
    for (const leak of [
      "ws-b",
      "Personal",
      "b1",
      "b2",
      "bank.example.com",
      "mail.example.com",
      "col-b1",
      "Money",
      "run-b",
      "Sort the receipts",
      "sort code",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("reports the exclusions rather than hiding them", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["tab", "collection"],
      tabIds: ["b1"],
      collectionIds: ["col-b1"],
    });

    expect(snapshot.omissions.map((o) => `${o.sourceType}:${o.reason}`)).toEqual(
      expect.arrayContaining(["tab:out-of-scope", "collection:out-of-scope"])
    );
  });
});

/* ------------------------------------------------------------------ *
 * 5. Hosted fail-closed
 * ------------------------------------------------------------------ */

describe("secret filtering", () => {
  it("removes credentials from every string a snapshot serializes", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["workspace", "tab", "collection", "relationship", "graph"],
      workspaceIds: ["ws-a"],
      collectionIds: ["col-a1"],
      graph: { centerTabIds: ["a1"], depth: 2 },
      includeNotes: true,
    });

    const serialized = JSON.stringify(snapshot);
    for (const secret of ["hunter2", "sk-live-SECRET", "eyJhbG", "alice:"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("a snapshot has no field that could hold a token even if one were found", () => {
    const snapshot = resolveOrThrow({
      scope: scopeA(),
      sources: ["tab"],
      workspaceIds: ["ws-a"],
    });

    for (const item of snapshot.items) {
      for (const key of Object.keys(item)) {
        expect(key).not.toMatch(/token|secret|password|cookie|credential|auth/i);
      }
    }
  });
});

describe("snapshot integrity", () => {
  const request: ContextRequest = {
    scope: scopeA(),
    sources: ["tab"],
    workspaceIds: ["ws-a"],
  };

  it("cannot be mutated after it is minted", () => {
    const snapshot = resolveOrThrow(request);

    expect(() => {
      (snapshot.items as unknown as unknown[]).push({ sourceType: "tab" });
    }).toThrow();
    expect(() => {
      (snapshot as unknown as Record<string, unknown>).capturedAt = 0;
    }).toThrow();
  });

});
