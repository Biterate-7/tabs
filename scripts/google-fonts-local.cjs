// next/font's NEXT_FONT_GOOGLE_MOCKED_RESPONSES file for the desktop export
// (scripts/desktop-export.mjs sets it): next/font looks each Google Fonts
// stylesheet address up here instead of fetching it itself.
//
// Nothing is mocked in the sense of fake data: on first lookup of an
// address, scripts/google-fonts-fetch.mjs fetches the real stylesheet and
// its font files from Google, saves the files under node_modules/.cache/
// hubble-fonts named by their real format, and returns the stylesheet
// pointing at them — so next/font no longer parses Google's font addresses,
// whose form varies by edge (see that script for the failure this avoids).
//
// next/font requires this file synchronously and indexes it by address, so
// it is a Proxy that answers each lookup by running the fetcher once (the
// result is cached on disk for the rest of the build and the next one).
// CommonJS on purpose: next/font loads this file with require().
/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const CACHE = path.join(__dirname, "..", "node_modules", ".cache", "hubble-fonts");
const FETCHER = path.join(__dirname, "google-fonts-fetch.mjs");

function stylesheet(url) {
  const file = path.join(CACHE, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.css`);
  if (!existsSync(file)) execFileSync(process.execPath, [FETCHER, url, file], { stdio: ["ignore", "inherit", "inherit"] });
  return readFileSync(file, "utf8");
}

module.exports = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== "string" || !key.startsWith("https://fonts.googleapis.com/")) return undefined;
      return stylesheet(key);
    },
  }
);
