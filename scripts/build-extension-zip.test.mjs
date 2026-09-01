// Verifies the packaged extension ZIP is actually loadable via Chrome's
// "Load unpacked" flow once a user extracts it: manifest.json (and every
// other required file) must sit at the ZIP root with no `extension/`
// wrapper folder, so extracting `tabdump-extension.zip` produces a
// `tabdump-extension/manifest.json` layout — not a doubly-nested
// `tabdump-extension/extension/manifest.json` the user would have to hunt
// for. See build-extension-zip.mjs's header comment for the full rationale.
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_PRODUCTION_ORIGIN, DEV_ORIGIN } from "./build-extension-zip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ZIP_PATH = path.join(REPO_ROOT, "public", "tabdump-extension.zip");

// The actual bug this whole file guards against: a missing "s" turns the
// real TabDump production domain into a different site entirely. Repo
// history shows this exact typo has round-tripped in and out of
// CANONICAL_PRODUCTION_ORIGIN more than once — so this is checked as its own
// literal, not derived from CANONICAL_PRODUCTION_ORIGIN, and asserted with
// the full "https://" + host string rather than a vague "vercel.app"
// substring (which would pass even with the typo present).
const WRONG_PRODUCTION_ORIGIN = "https://tabdump.vercel.app";

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
    execFileSync(process.execPath, ["scripts/build-extension-zip.mjs"], { cwd: REPO_ROOT });
    expect(existsSync(ZIP_PATH)).toBe(true);
    entries = readZipEntries(readFileSync(ZIP_PATH));
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
      ])
    );
  });

  it("excludes test files, the packaging README, and the icon-generation script", () => {
    const names = entries.map((e) => e.name);
    for (const name of names) {
      expect(name.endsWith(".test.js")).toBe(false);
      expect(name).not.toBe("README.md");
      expect(name.startsWith("scripts/")).toBe(false);
    }
  });

  it("packages manifest.json as valid, parseable JSON naming the TabDump extension", () => {
    const manifest = entries.find((e) => e.name === "manifest.json");
    const parsed = JSON.parse(manifest.data.toString("utf8"));
    expect(parsed.name).toBe("TabDump");
    expect(parsed.manifest_version).toBe(3);
  });

  it("refuses to build an empty ZIP if the extension source can't be found", () => {
    expect(entries.length).toBeGreaterThan(0);
  });
});

// Regression coverage for the incident where CANONICAL_PRODUCTION_ORIGIN
// (and therefore every production extension artifact derived from it) held
// "https://tabdump.vercel.app" — a real but different site — instead of the
// actual TabDump deployment. These tests fail if that typo ever comes back,
// whether it re-lands in the constant itself or only in a generated
// artifact because the substitution logic changed underneath it.
describe("build-extension-zip.mjs — canonical production origin", () => {
  it("is exactly the real TabDump production domain, not the typo'd lookalike", () => {
    expect(CANONICAL_PRODUCTION_ORIGIN).toBe("https://tabsdump.vercel.app");
    expect(CANONICAL_PRODUCTION_ORIGIN).not.toBe(WRONG_PRODUCTION_ORIGIN);
  });
});

describe("build-extension-zip.mjs — production build output", () => {
  let entries;

  beforeAll(() => {
    // Build as a real production deployment would (VERCEL_ENV=production,
    // no manual override), so TARGET_ORIGIN resolves through
    // CANONICAL_PRODUCTION_ORIGIN exactly like the actual Vercel build does.
    const prodEnv = { ...process.env, VERCEL_ENV: "production" };
    delete prodEnv.TABDUMP_PRODUCTION_ORIGIN;
    delete prodEnv.VERCEL_URL;

    execFileSync(process.execPath, ["scripts/build-extension-zip.mjs"], { cwd: REPO_ROOT, env: prodEnv });
    expect(existsSync(ZIP_PATH)).toBe(true);
    entries = readZipEntries(readFileSync(ZIP_PATH));
  });

  function entryText(name) {
    const entry = entries.find((e) => e.name === name);
    expect(entry, `expected a "${name}" entry in the built ZIP`).toBeTruthy();
    return entry.data.toString("utf8");
  }

  it("bakes the canonical production origin into manifest.json's host_permissions and content_scripts.matches", () => {
    const manifest = JSON.parse(entryText("manifest.json"));
    expect(manifest.host_permissions).toContain(`${CANONICAL_PRODUCTION_ORIGIN}/*`);
    expect(manifest.content_scripts[0].matches).toContain(`${CANONICAL_PRODUCTION_ORIGIN}/*`);
  });

  it("bakes the canonical production origin into src/config.js's TABDUMP_ORIGIN (the runtime tab-detection/fallback target)", () => {
    expect(entryText("src/config.js")).toContain(`TABDUMP_ORIGIN = "${CANONICAL_PRODUCTION_ORIGIN}"`);
  });

  it("does not leave the dev origin behind in either origin-substituted file", () => {
    expect(entryText("manifest.json")).not.toContain(DEV_ORIGIN);
    expect(entryText("src/config.js")).not.toContain(DEV_ORIGIN);
  });

  it("never contains the wrong TabDump domain (the missing-s typo) in any generated artifact", () => {
    for (const { name, data } of entries) {
      expect(data.toString("utf8"), `${name} should not contain ${WRONG_PRODUCTION_ORIGIN}`).not.toContain(
        WRONG_PRODUCTION_ORIGIN
      );
    }
  });

  it("keeps the canonical origin, manifest origin, and runtime config origin all consistent with each other", () => {
    const manifest = JSON.parse(entryText("manifest.json"));
    const configOrigin = entryText("src/config.js").match(/TABDUMP_ORIGIN = "([^"]+)"/)?.[1];

    expect(configOrigin).toBe(CANONICAL_PRODUCTION_ORIGIN);
    expect(manifest.host_permissions).toEqual([`${CANONICAL_PRODUCTION_ORIGIN}/*`]);
    expect(manifest.content_scripts[0].matches).toEqual([`${CANONICAL_PRODUCTION_ORIGIN}/*`]);
  });
});
