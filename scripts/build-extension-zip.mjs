// Packages extension/ into public/tabdump-extension.zip so it's served as
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
// `tabdump-extension.zip` — with Windows' "Extract All", macOS Archive
// Utility, or `unzip` on the command line — produces manifest.json sitting
// directly inside the extracted `tabdump-extension` folder. Those tools
// name the extracted folder after the archive precisely because the
// archive has no single top-level folder of its own; nesting one in here
// would instead produce `tabdump-extension/extension/manifest.json`,
// forcing users to hunt for the folder Chrome's "Load unpacked" actually
// wants. See the onboarding guide (extension-install-guide.tsx) for the
// matching install instructions.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
const OUTPUT_PATH = path.join(REPO_ROOT, "public", "tabdump-extension.zip");

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
// TABDUMP_PRODUCTION_ORIGIN: set this to override (e.g. if the canonical
// domain below ever changes). Otherwise this defaults to TabDump's actual
// canonical production domain — deliberately NOT derived from Vercel's
// VERCEL_PROJECT_PRODUCTION_URL, which reflects whatever domain the Vercel
// project happens to be assigned (e.g. an auto-suffixed tabdump-eight.vercel.app
// if the exact project name was taken) rather than the domain TabDump is
// actually meant to be reached at. Preview builds are the one case that
// legitimately need a different, per-deployment origin — those still pick
// up Vercel's own VERCEL_URL, a fresh throwaway URL every build. Baking a
// Preview's VERCEL_URL into a Production build would instead mean every new
// deployment silently invalidates every previously downloaded extension
// ZIP: the extension's host_permissions/content_scripts match only that one
// build's URL, so chrome.tabs.query()/tabs.create() in background.js's
// findOrOpenTabDumpTab() end up targeting a stale, deployment-specific
// origin instead of the domain the user is actually looking at — landing
// imported tabs in a different origin's localStorage than the one being
// viewed, with no visible error. Falls back to localhost:3000 for a plain
// local build with none of these set.
const DEV_ORIGIN = "http://localhost:3000";
const CANONICAL_PRODUCTION_ORIGIN = "https://tabsdump.vercel.app";
const TARGET_ORIGIN =
  process.env.TABDUMP_PRODUCTION_ORIGIN ||
  (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : null) ||
  (process.env.VERCEL_ENV === "production" ? CANONICAL_PRODUCTION_ORIGIN : null) ||
  DEV_ORIGIN;

const ORIGIN_SUBSTITUTED_FILES = new Set([
  path.join("manifest.json"),
  path.join("src", "config.js"),
]);

function isExcluded(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  if (EXCLUDED_FILES.has(parts[parts.length - 1])) return true;
  if (relativePath.endsWith(".test.js")) return true;
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

function buildZip(files) {
  const { dosTime, dosDate } = dosDateTime(new Date());
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const relativePath of files) {
    const absolutePath = path.join(EXTENSION_DIR, relativePath);
    let data = readFileSync(absolutePath);

    if (ORIGIN_SUBSTITUTED_FILES.has(relativePath) && TARGET_ORIGIN !== DEV_ORIGIN) {
      data = Buffer.from(data.toString("utf8").split(DEV_ORIGIN).join(TARGET_ORIGIN), "utf8");
    }
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

const files = walk(EXTENSION_DIR).sort();
if (files.length === 0) {
  throw new Error(`No files found under ${EXTENSION_DIR} — refusing to write an empty ZIP.`);
}

const zip = buildZip(files);
mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, zip);

console.log(`Extension origin baked into this ZIP: ${TARGET_ORIGIN}`);
console.log(`Wrote ${OUTPUT_PATH} (${zip.length} bytes, ${files.length} files):`);
for (const f of files) console.log(`  ${f.split(path.sep).join("/")}`);
