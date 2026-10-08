// Verifies the packaged extension ZIP is actually loadable via Chrome's
// "Load unpacked" flow once a user extracts it: manifest.json (and every
// other required file) must sit at the ZIP root with no `extension/`
// wrapper folder, so extracting `hubble-extension.zip` produces a
// `hubble-extension/manifest.json` layout — not a doubly-nested
// `hubble-extension/extension/manifest.json` the user would have to hunt
// for. See build-extension-zip.mjs's header comment for the full rationale.
import { afterAll, afterEach, describe, expect, it, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_PRODUCTION_ORIGIN, DEV_ORIGIN } from "./build-extension-zip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ZIP_PATH = path.join(REPO_ROOT, "public", "hubble-extension.zip");

// Origins no generated artifact may ever contain. Written out as literals
// rather than imported from RETIRED_ORIGINS, so emptying that list can't make
// these tests pass vacuously:
//   - tabsdump.vercel.app: the old production alias, removed from the Vercel
//     project; it now answers 404 DEPLOYMENT_NOT_FOUND, and every packaged
//     extension that baked it in opened that error page on "Dump Tabs".
//   - tabdump.vercel.app: a one-letter lookalike belonging to another site,
//     which has round-tripped in and out of the constant more than once.
const DEAD_ORIGINS = ["https://tabsdump.vercel.app", "https://tabdump.vercel.app"];

// Every env var resolveProductionOrigin() reads, so each build below states
// its whole environment instead of inheriting the test runner's.
const ORIGIN_ENV_KEYS = ["TABDUMP_PRODUCTION_ORIGIN", "VERCEL_ENV", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"];

function envWith(patch) {
  const env = { ...process.env };
  for (const key of ORIGIN_ENV_KEYS) delete env[key];
  return { ...env, ...patch };
}

function buildWith(patch) {
  execFileSync(process.execPath, ["scripts/build-extension-zip.mjs"], { cwd: REPO_ROOT, env: envWith(patch), stdio: "pipe" });
  expect(existsSync(ZIP_PATH)).toBe(true);
  return readZipEntries(readFileSync(ZIP_PATH));
}

function entryTextIn(entries, name) {
  const entry = entries.find((e) => e.name === name);
  expect(entry, `expected a "${name}" entry in the built ZIP`).toBeTruthy();
  return entry.data.toString("utf8");
}

/** The single origin a built ZIP targets, asserting all three places agree. */
function bakedOrigin(entries) {
  const manifest = JSON.parse(entryTextIn(entries, "manifest.json"));
  const configOrigin = entryTextIn(entries, "src/config.js").match(/TABDUMP_ORIGIN = "([^"]+)"/)?.[1];
  expect(manifest.host_permissions).toEqual([`${configOrigin}/*`]);
  expect(manifest.content_scripts[0].matches).toEqual([`${configOrigin}/*`]);
  return configOrigin;
}

/** Minimal reader for the STORED-only ZIP subset build-extension-zip.mjs writes. */
function readZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Not a valid ZIP: no End Of Central Directory record found");

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let cdPtr = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(cdPtr) !== 0x02014b50) throw new Error("Malformed central directory record");
    const compSize = buffer.readUInt32LE(cdPtr + 20);
    const uncompSize = buffer.readUInt32LE(cdPtr + 24);
    const nameLen = buffer.readUInt16LE(cdPtr + 28);
    const extraLen = buffer.readUInt16LE(cdPtr + 30);
    const commentLen = buffer.readUInt16LE(cdPtr + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdPtr + 42);
    const name = buffer.toString("utf8", cdPtr + 46, cdPtr + 46 + nameLen);

    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const data = buffer.subarray(dataStart, dataStart + compSize);

    entries.push({ name, uncompSize, data });
    cdPtr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("build-extension-zip.mjs", () => {
  let entries;

  beforeAll(() => {
    entries = buildWith({});
  });

  it("places manifest.json at the ZIP root, not nested under an extension/ folder", () => {
    const names = entries.map((e) => e.name);
    expect(names).toContain("manifest.json");
    expect(names).not.toContain("extension/manifest.json");
  });

  it("has no entries nested under an extension/ wrapper folder", () => {
    for (const { name } of entries) {
      expect(name.startsWith("extension/")).toBe(false);
    }
  });

  it("includes every required extension source file", () => {
    const names = entries.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "background/background.js",
        "content/content-script.js",
        "popup/popup.css",
        "popup/popup.html",
        "popup/popup.js",
        "icons/icon16.png",
        "icons/icon48.png",
        "icons/icon128.png",
        "src/config.js",
        "src/tabs.js",
        "src/tab-matching.js",
        "src/browser-actions.js",
        "src/browser-commands.js",
        "src/quick-add.js",
      ])
    );
  });

  it("excludes test files, the packaging README, and the icon-generation script", () => {
    const names = entries.map((e) => e.name);
    for (const name of names) {
      // Any test-shaped name, not just .test.js: a future .test.mjs/.test.ts
      // living next to the source it covers must not ship inside the
      // extension users download.
      expect(name).not.toMatch(/\.(test|spec)\.[cm]?[jt]sx?$/);
      expect(name).not.toBe("README.md");
      expect(name.startsWith("scripts/")).toBe(false);
    }
    // The one that exists today is genuinely on disk next to its source, so
    // this asserts the exclusion is doing work rather than passing vacuously.
    expect(existsSync(path.join(REPO_ROOT, "extension", "content", "content-script.test.js"))).toBe(true);
    expect(names).not.toContain("content/content-script.test.js");
  });

  // Everything the popup's DOM lookups and the module graph need must be in
  // the archive: popup.js resolves every element by id at load and throws
  // outright if one is missing, and each of these modules is imported by
  // path from another packaged file. A missing entry here is not a degraded
  // extension, it is one that does nothing at all when clicked.
  it("packages a popup whose element ids all exist in the packaged HTML", () => {
    const html = entries.find((e) => e.name === "popup/popup.html").data.toString("utf8");
    const js = entries.find((e) => e.name === "popup/popup.js").data.toString("utf8");
    const requestedIds = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);

    expect(requestedIds.length).toBeGreaterThan(0);
    for (const id of requestedIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("packages manifest.json as valid, parseable JSON naming the Hubble extension", () => {
    const manifest = entries.find((e) => e.name === "manifest.json");
    const parsed = JSON.parse(manifest.data.toString("utf8"));
    expect(parsed.name).toBe("Hubble");
    expect(parsed.manifest_version).toBe(3);
  });

  it("refuses to build an empty ZIP if the extension source can't be found", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  // A content script that is registered but never packaged, or packaged
  // under a path the manifest doesn't name, produces the single least
  // diagnosable failure this extension has: Chrome's "Could not establish
  // connection. Receiving end does not exist.", from a ZIP that installs
  // cleanly and looks correct in chrome://extensions.
  it("packages every file the content_scripts registration names", () => {
    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    const names = entries.map((e) => e.name);

    expect(manifest.content_scripts.length).toBeGreaterThan(0);
    for (const registration of manifest.content_scripts) {
      expect(registration.js.length).toBeGreaterThan(0);
      for (const file of registration.js) {
        expect(names, `manifest registers ${file}, which is not in the ZIP`).toContain(file);
      }
    }
  });

  // document_idle is explicitly documented as injecting anywhere between
  // document_end and *immediately after* window.onload — i.e. it is allowed
  // to land after the moment chrome.tabs.onUpdated reports `status:
  // "complete"`, which is exactly when background.js delivers. On a warm
  // machine the script won that race; on a cold one (fresh profile, uncached
  // bundle, slower hardware — a first install, in other words) it lost, and
  // the dump failed against a tab that had visibly finished loading.
  // document_start injects before the page's own scripts, removing the race
  // instead of widening the retry window around it.
  it("registers the content script at document_start, so it is attached before a tab can report complete", () => {
    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    for (const registration of manifest.content_scripts) {
      expect(registration.run_at).toBe("document_start");
    }
  });

  // Without this permission chrome.scripting.executeScript is simply absent,
  // and background.js's repair for a tab that predates the extension's
  // installation degrades to a no-op — the exact tab onboarding's last step
  // tells every new user to dump into.
  it("grants the scripting permission the missing-content-script repair depends on", () => {
    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    expect(manifest.permissions).toContain("scripting");
  });

  // background.js injects CONTENT_SCRIPT_FILE by name. If that constant and
  // the manifest's registration ever name different paths, the repair
  // injects the wrong file (or nothing) and reports a second, differently
  // worded failure instead of fixing the first.
  it("keeps the packaged config's CONTENT_SCRIPT_FILE identical to the packaged manifest's content-script path", () => {
    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    const config = entries.find((e) => e.name === "src/config.js").data.toString("utf8");
    const declared = config.match(/CONTENT_SCRIPT_FILE = "([^"]+)"/)?.[1];

    expect(declared).toBeTruthy();
    expect(manifest.content_scripts[0].js).toContain(declared);
    expect(entries.map((e) => e.name)).toContain(declared);
  });
});

// Regression coverage for the "Dump Tabs opens 404 DEPLOYMENT_NOT_FOUND"
// incident. The extension only ever queries, injects into and opens the one
// origin baked into it (background.js's chrome.tabs.query/tabs.create on
// TABDUMP_ORIGIN), so the origin baked in here IS where "Dump Tabs" goes.
describe("build-extension-zip.mjs — canonical production origin", () => {
  it("is the Vercel project's production domain, not a dead or foreign one", () => {
    expect(CANONICAL_PRODUCTION_ORIGIN).toBe("https://hubble-hq.vercel.app");
    for (const dead of DEAD_ORIGINS) expect(CANONICAL_PRODUCTION_ORIGIN).not.toBe(dead);
  });
});

describe("build-extension-zip.mjs — Vercel production build", () => {
  const PRODUCTION_DOMAIN = "hubble.example.com";
  const DEPLOYMENT_URL = "tabs-gtxma8nys-ayaan-viswanathans-projects.vercel.app";
  let entries;

  beforeAll(() => {
    // Exactly what Vercel sets on a production build: the per-deployment
    // VERCEL_URL alongside the project's production domain.
    entries = buildWith({
      VERCEL_ENV: "production",
      VERCEL_URL: DEPLOYMENT_URL,
      VERCEL_PROJECT_PRODUCTION_URL: PRODUCTION_DOMAIN,
    });
  });

  it("targets the project's production domain as Vercel reports it", () => {
    expect(bakedOrigin(entries)).toBe(`https://${PRODUCTION_DOMAIN}`);
  });

  it("never bakes in the deployment-specific URL, which dies with its deployment", () => {
    for (const { name, data } of entries) {
      expect(data.toString("utf8"), `${name} should not contain ${DEPLOYMENT_URL}`).not.toContain(DEPLOYMENT_URL);
    }
  });

  it("does not leave the dev origin behind in either origin-substituted file", () => {
    expect(entryTextIn(entries, "manifest.json")).not.toContain(DEV_ORIGIN);
    expect(entryTextIn(entries, "src/config.js")).not.toContain(DEV_ORIGIN);
  });

  it("never contains a dead or foreign Hubble origin in any generated artifact", () => {
    for (const { name, data } of entries) {
      for (const dead of DEAD_ORIGINS) {
        expect(data.toString("utf8"), `${name} should not contain ${dead}`).not.toContain(dead);
      }
    }
  });
});

describe("build-extension-zip.mjs — Vercel production build without a production domain", () => {
  it("falls back to the canonical origin, still ignoring the per-deployment VERCEL_URL", () => {
    const entries = buildWith({ VERCEL_ENV: "production", VERCEL_URL: "tabs-abc123xyz-team.vercel.app" });
    expect(bakedOrigin(entries)).toBe(CANONICAL_PRODUCTION_ORIGIN);
  });
});

describe("build-extension-zip.mjs — Vercel preview build", () => {
  it("targets the preview's own URL, so a preview's extension talks to that preview", () => {
    const entries = buildWith({
      VERCEL_ENV: "preview",
      VERCEL_URL: "tabs-abc123xyz-team.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "hubble.example.com",
    });
    expect(bakedOrigin(entries)).toBe("https://tabs-abc123xyz-team.vercel.app");
  });
});

// A dead origin left behind in configuration (e.g. a TABDUMP_PRODUCTION_ORIGIN
// set in the Vercel dashboard back when the alias was live) would override
// everything above. That has to stop the deploy, not ship an extension that
// opens an error page.
describe("build-extension-zip.mjs — refuses dead origins", () => {
  it.each(DEAD_ORIGINS)("fails the build when configured with %s", (dead) => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/build-extension-zip.mjs"], {
        cwd: REPO_ROOT,
        env: envWith({ TABDUMP_PRODUCTION_ORIGIN: dead }),
        stdio: "pipe",
      })
    ).toThrow(/resolved to https:\/\/tabs?dump\.vercel\.app/);
  });
});

// Regression coverage for the actual "works on my computer, not on another's"
// incident: a plain `npm run build` run anywhere other than Vercel's own
// pipeline (a developer's machine, a non-Vercel host, `next build && next
// start` for local testing) has none of Vercel's env vars set. The
// downloadable ZIP built in that situation must still target the real
// production origin — the same artifact real users get from onboarding's
// "Download Extension" button — instead of silently baking in the builder's
// own localhost, which only that one machine could ever reach.
describe("build-extension-zip.mjs — default build output (no environment configured)", () => {
  let entries;

  beforeAll(() => {
    entries = buildWith({});
  });

  it("defaults to the canonical production origin, not localhost, with no environment configured", () => {
    expect(bakedOrigin(entries)).toBe(CANONICAL_PRODUCTION_ORIGIN);
  });

  it("never leaves the dev origin in a ZIP built with no environment configured", () => {
    expect(entryTextIn(entries, "manifest.json")).not.toContain(DEV_ORIGIN);
    expect(entryTextIn(entries, "src/config.js")).not.toContain(DEV_ORIGIN);
  });
});

// The packaged extension itself, end to end: build the ZIP exactly as a Vercel
// production deploy does, extract it, load *its* background.js (with *its*
// baked config.js) and run a real "Dump Tabs". Only chrome.* is faked. This is
// the path that produced the 404: with a dead origin baked in, the url-filtered
// query never found the user's Hubble tab and the fallback chrome.tabs.create
// opened DEPLOYMENT_NOT_FOUND instead.
describe("packaged extension — Dump Tabs against the production origin", () => {
  // What Vercel actually sets VERCEL_PROJECT_PRODUCTION_URL to for this project.
  const PRODUCTION_DOMAIN = "hubble-hq.vercel.app";
  const ORIGIN = `https://${PRODUCTION_DOMAIN}`;
  let extractDir;
  let listeners;

  function fakeTab(over) {
    return { id: 1, windowId: 10, url: "https://example.com", title: "Example", pinned: false, active: false, index: 0, ...over };
  }

  beforeAll(() => {
    const entries = buildWith({
      VERCEL_ENV: "production",
      VERCEL_URL: "tabs-gtxma8nys-ayaan-viswanathans-projects.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: PRODUCTION_DOMAIN,
    });
    // Inside the project (gitignored node_modules/.cache), because Vite will
    // not load modules from outside its root (e.g. the OS temp directory).
    const cacheDir = path.join(REPO_ROOT, "node_modules", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    extractDir = mkdtempSync(path.join(cacheDir, "hubble-packaged-extension-"));
    for (const { name, data } of entries) {
      const target = path.join(extractDir, ...name.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
  });

  afterAll(() => {
    if (extractDir) rmSync(extractDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete globalThis.chrome;
    vi.resetModules();
  });

  async function loadPackagedBackground({ openTabs }) {
    listeners = [];
    globalThis.chrome = {
      runtime: { onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) } },
      tabs: {
        query: vi.fn(async (query) => {
          if (query.windowId !== undefined) return openTabs.filter((tab) => tab.windowId === query.windowId);
          if (query.url) {
            // Chrome's own match-pattern semantics for "<origin>/*".
            const prefix = query.url.slice(0, -1);
            return openTabs.filter((tab) => tab.url.startsWith(prefix));
          }
          return [];
        }),
        create: vi.fn(async ({ url }) => fakeTab({ id: 99, url })),
        update: vi.fn(),
        // The packaged content script answering for the page: it acks the batch.
        sendMessage: vi.fn(async (_tabId, message) =>
          message?.type === "TABDUMP_IMPORT" ? { ok: true, accepted: message.payload.tabs.length } : undefined
        ),
        get: vi.fn(async (id) => fakeTab({ id, status: "loading" })),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
      windows: { update: vi.fn() },
      storage: { session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) } },
    };
    // Forward slashes: Vite resolves "C:/…" but not "C:\…".
    await import(/* @vite-ignore */ path.join(extractDir, "background", "background.js").split(path.sep).join("/"));
    return listeners[0];
  }

  function dump(listener, payload) {
    return new Promise((resolve) => listener({ type: "DUMP_TABS", payload }, {}, resolve));
  }

  it("sends the tabs to the Hubble tab the user already has open, without opening a new one", async () => {
    const openTabs = [
      fakeTab({ id: 1, url: "https://a.example/one", title: "One" }),
      fakeTab({ id: 2, url: "https://b.example/two", title: "Two" }),
      // Hubble open in another window: found by origin, not by window.
      fakeTab({ id: 42, windowId: 20, url: `${ORIGIN}/`, title: "Hubble", active: true }),
    ];
    const listener = await loadPackagedBackground({ openTabs });

    const response = await dump(listener, { windowId: 10, excludeUrls: [] });

    expect(chrome.tabs.query).toHaveBeenCalledWith({ url: `${ORIGIN}/*` });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    const delivered = chrome.tabs.sendMessage.mock.calls.find(([, m]) => m?.type === "TABDUMP_IMPORT");
    expect(delivered[0]).toBe(42);
    expect(delivered[1].payload.tabs.map((t) => t.url)).toEqual(["https://a.example/one", "https://b.example/two"]);
    expect(response).toMatchObject({ ok: true, status: "done", accepted: 2, focusTabId: 42 });
  });

  it("opens Hubble's app route on the production origin — never a dead or deployment URL — when no Hubble tab is open", async () => {
    const listener = await loadPackagedBackground({ openTabs: [fakeTab({ id: 1, url: "https://a.example/one" })] });

    const responsePromise = dump(listener, { windowId: 10, excludeUrls: [] });
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });
    const response = await responsePromise;

    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    const [{ url, active }] = chrome.tabs.create.mock.calls[0];
    expect(url).toBe(ORIGIN);
    expect(new URL(url).pathname).toBe("/"); // TABDUMP_APP_PATH, the route that mounts AppShell
    expect(active).toBe(false);
    for (const dead of DEAD_ORIGINS) expect(url.startsWith(dead)).toBe(false);
    expect(url).not.toContain("gtxma8nys");
    expect(response).toMatchObject({ ok: true, status: "done", accepted: 1, focusTabId: 99 });
  });

  it("skips tabs already in the workspace, exactly as the unpacked extension does", async () => {
    const openTabs = [
      fakeTab({ id: 1, url: "https://a.example/one" }),
      fakeTab({ id: 2, url: "https://b.example/two" }),
      fakeTab({ id: 42, windowId: 20, url: `${ORIGIN}/`, active: true }),
    ];
    const listener = await loadPackagedBackground({ openTabs });

    const response = await dump(listener, { windowId: 10, excludeUrls: ["https://a.example/one"] });

    const delivered = chrome.tabs.sendMessage.mock.calls.find(([, m]) => m?.type === "TABDUMP_IMPORT");
    expect(delivered[1].payload.tabs.map((t) => t.url)).toEqual(["https://b.example/two"]);
    expect(response).toMatchObject({ ok: true, skippedAlreadyImported: 1, accepted: 1 });
  });
});
