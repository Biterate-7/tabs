// Packages extension/ into public/hubble-extension.zip so it's served as
// a plain static file by Next.js — in dev via `next dev` and in production
// via Vercel's static asset serving, with no backend/API route/database
// involved. Runs before every build (wired into package.json's "build"
// script) so the ZIP can never drift out of sync with extension/'s source.
//
// Hand-rolls the ZIP container format using only Node's built-in `zlib`
// (for CRC-32) and `fs`/`path` — no archiver dependency needed for a
// handful of small text/PNG files. Every entry uses the STORED method (no
// compression): this keeps the implementation simple and low-risk (no
// DEFLATE-in-ZIP edge cases to get wrong) and costs nothing meaningful for
// an archive this small. Entries are stored FLAT at the ZIP root (no
// `extension/` prefix) so that extracting the downloaded
// `hubble-extension.zip` — with Windows' "Extract All", macOS Archive
// Utility, or `unzip` on the command line — produces manifest.json sitting
// directly inside the extracted `hubble-extension` folder. Those tools
// name the extracted folder after the archive precisely because the
// archive has no single top-level folder of its own; nesting one in here
// would instead produce `hubble-extension/extension/manifest.json`,
// forcing users to hunt for the folder Chrome's "Load unpacked" actually
// wants. See the onboarding guide (extension-install-guide.tsx) for the
// matching install instructions.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_ORIGIN, CANONICAL_PRODUCTION_ORIGIN, RETIRED_ORIGINS, resolveProductionOrigin } from "../src/lib/production-origin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
const OUTPUT_PATH = path.join(REPO_ROOT, "public", "hubble-extension.zip");

const EXCLUDED_DIRS = new Set(["scripts"]);
const EXCLUDED_FILES = new Set(["README.md"]);

// extension/manifest.json and extension/src/config.js hardcode
// http://localhost:3000 for the local dev workflow (loading extension/
// directly, unpacked, always targets the dev server). A ZIP downloaded
// from a real deployment needs to target that deployment's own origin
// instead, or the packaged extension would only ever work against
// localhost. This substitutes the origin in the ZIP's copies of those two
// files only — the actual files on disk are never touched, so `npm run
// dev` + loading extension/ unpacked keeps working exactly as before.
//
// Which origin gets baked in is decided by resolveProductionOrigin() in
// src/lib/production-origin.mjs — shared with the site's own canonical URL so
// the two can never disagree. In short: an explicit TABDUMP_PRODUCTION_ORIGIN,
// else a Vercel preview's own VERCEL_URL, else a Vercel production build's
// VERCEL_PROJECT_PRODUCTION_URL, else CANONICAL_PRODUCTION_ORIGIN.
//
// Why a production build asks Vercel rather than trusting a hardcoded domain:
// this ZIP used to bake in a hand-typed vercel.app alias (now listed in
// RETIRED_ORIGINS). When that alias was removed from the Vercel project it
// began answering every request with 404 DEPLOYMENT_NOT_FOUND — and because
// the extension only ever queries, injects into and opens its one baked-in
// origin, every "Dump Tabs" from then on skipped the user's real Hubble tab
// and opened that error page in a new tab instead, while the site itself
// kept working at its real domain.
// VERCEL_PROJECT_PRODUCTION_URL is the domain Vercel is actually routing
// production to at build time, so it cannot go stale the same way.
//
// A production build never uses VERCEL_URL: that is the per-deployment hash
// URL, and baking it in would mean every new deployment silently invalidates
// every previously downloaded extension ZIP — tabs landing in a different
// origin's localStorage than the one being viewed, with no visible error.
//
// Defaults to the canonical production origin — NOT localhost:3000 — for
// every build that isn't explicitly configured otherwise, including a plain
// local `npm run build` with none of Vercel's env vars set. This ZIP (see
// OUTPUT_PATH below) is exactly what onboarding serves real users via the
// "Download Extension" button (src/lib/extension-config.ts's
// EXTENSION_DOWNLOAD_URL): defaulting it to localhost used to mean *any*
// build run outside Vercel's own pipeline — a developer's own `npm run
// build`, testing `next build && next start` locally, deploying to a
// non-Vercel host — silently baked in the builder's personal localhost as a
// permanent part of the downloadable extension. That extension then only
// ever worked on the one machine that happened to have a matching dev server
// running; installed anywhere else, host_permissions/content_scripts never
// matched any real page, no content script ever attached, and every dump
// failed with Chrome's "Could not establish connection. Receiving end does
// not exist." — a silent, undetectable-until-install cross-machine failure.
// A developer who genuinely wants a localhost-targeting ZIP (to test the
// full download → unpack → load-unpacked → dump flow against a local dev
// server) can still get one explicitly via
// `TABDUMP_PRODUCTION_ORIGIN=http://localhost:3000 npm run build`. This
// only governs the ZIP; the on-disk extension/manifest.json and
// extension/src/config.js (used for `npm run dev` + "Load unpacked" straight
// from the extension/ folder) are never touched by this script and keep
// hardcoding localhost:3000.
export { DEV_ORIGIN, CANONICAL_PRODUCTION_ORIGIN };

const ORIGIN_SUBSTITUTED_FILES = new Set([
  path.join("manifest.json"),
  path.join("src", "config.js"),
]);

// Any extension source whose name marks it as a test, in any extension the
// repo might grow into (.test.js today, but .test.mjs/.test.ts/.test.tsx are
// all one `npm i` away). Matched on the pattern rather than one hardcoded
// suffix so a future test file can't quietly ship to users inside the
// downloadable extension.
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;

function isExcluded(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  if (EXCLUDED_FILES.has(parts[parts.length - 1])) return true;
  if (TEST_FILE_PATTERN.test(relativePath)) return true;
  return false;
}

function walk(dir, base = "") {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const relativePath = path.join(base, name);
    if (isExcluded(relativePath)) continue;

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...walk(fullPath, relativePath));
    } else {
      entries.push(relativePath);
    }
  }
  return entries;
}

function dosDateTime(date) {
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

// The bytes a file ships with: its source, with the dev origin swapped for
// the target origin in the files that carry it.
function packagedContents(relativePath, targetOrigin) {
  const data = readFileSync(path.join(EXTENSION_DIR, relativePath));
  if (!ORIGIN_SUBSTITUTED_FILES.has(relativePath) || targetOrigin === DEV_ORIGIN) return data;
  return Buffer.from(data.toString("utf8").split(DEV_ORIGIN).join(targetOrigin), "utf8");
}

function buildZip(files, targetOrigin) {
  const { dosTime, dosDate } = dosDateTime(new Date());
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const relativePath of files) {
    const data = packagedContents(relativePath, targetOrigin);
    // Force forward slashes regardless of platform, per the ZIP spec (paths
    // are always "/"-separated). No folder prefix: entries sit at the ZIP
    // root, see the header comment above for why.
    const zipEntryName = relativePath.split(path.sep).join("/");
    const nameBuf = Buffer.from(zipEntryName, "utf8");
    const crc = crc32(data) >>> 0;
    const size = data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: stored
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18); // compressed size
    localHeader.writeUInt32LE(size, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: stored
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0o644 << 16, 38); // external attributes (unix perms)
    centralHeader.writeUInt32LE(offset, 42); // offset of local header

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where CD starts
  eocd.writeUInt16LE(files.length, 8); // records on this disk
  eocd.writeUInt16LE(files.length, 10); // total records
  eocd.writeUInt32LE(centralDirectory.length, 12); // size of CD
  eocd.writeUInt32LE(centralDirectoryOffset, 16); // offset of CD
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

// Guarded so this module can be `import`ed (e.g. by tests, to read
// DEV_ORIGIN) without the side effect of rebuilding and
// overwriting the ZIP on disk — the actual build only runs when this file
// is executed directly, as `npm run prebuild` and build-extension-zip.test.mjs
// both do.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const files = walk(EXTENSION_DIR).sort();
  if (files.length === 0) {
    throw new Error(`No files found under ${EXTENSION_DIR} — refusing to write an empty ZIP.`);
  }

  // Throws — failing the build — if the configuration resolves to a retired
  // origin, e.g. a TABDUMP_PRODUCTION_ORIGIN left pointing at the old alias.
  const targetOrigin = resolveProductionOrigin(process.env);

  // Fail loudly instead of silently packaging a broken extension: no shipped
  // file may carry a retired origin, however it got there.
  for (const relativePath of files) {
    const text = packagedContents(relativePath, targetOrigin).toString("utf8");
    for (const [retired, why] of Object.entries(RETIRED_ORIGINS)) {
      if (text.includes(retired)) {
        throw new Error(`Refusing to build: ${relativePath} would ship the retired origin ${retired} (${why}).`);
      }
    }
  }

  const zip = buildZip(files, targetOrigin);

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, zip);

  console.log(`Extension origin baked into this ZIP: ${targetOrigin}`);
  console.log(`Wrote ${OUTPUT_PATH} (${zip.length} bytes, ${files.length} files):`);
  for (const f of files) console.log(`  ${f.split(path.sep).join("/")}`);
}
