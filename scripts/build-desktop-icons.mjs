// Generates the desktop app's icon set from the SAME source mark the web
// favicon and the extension toolbar icons use (src/app/icon.svg), so the
// three distribution targets can't drift apart visually. Mirrors
// extension/scripts/generate-icons.mjs in intent; the difference is that a
// desktop icon is shown at large sizes on an arbitrary desktop background,
// so the bare stroke glyph is composited onto TabDump's accent colour
// instead of being rasterized on transparency (where it would vanish
// against a dark taskbar).
//
// Run with: npm run desktop:icons
//
// Step 1 (here) renders a 1024px master PNG. Step 2 hands it to the Tauri
// CLI, which is what actually produces the platform containers — .ico for
// Windows, .icns for macOS, and the PNG ladder for Linux — since those are
// packing formats sharp does not write.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SOURCE_SVG = path.join(ROOT, "src", "app", "icon.svg");
const ICONS_DIR = path.join(ROOT, "src-tauri", "icons");
const MASTER_PNG = path.join(ICONS_DIR, "icon.png");

// TabDump's default theme accent (`midnight` in src/lib/appearance/themes.ts).
const ACCENT = "#4361ff";
const GLYPH = "#ffffff";
const SIZE = 1024;

// Pull the mark's path out of the source SVG rather than restating it, so
// editing icon.svg is enough to restyle every target.
const svgSource = readFileSync(SOURCE_SVG, "utf8");
const pathMatch = svgSource.match(/<path[^>]*\sd="([^"]+)"/);
if (!pathMatch) {
  throw new Error(`Could not find a <path d="…"> in ${SOURCE_SVG}`);
}
const markPath = pathMatch[1];

// The source mark is drawn in a 24x24 viewBox. Scaled to ~61% of the
// canvas it leaves the margin platform icon masks (macOS squircle, Windows
// rounded tile) expect without clipping the stroke.
const scale = (SIZE * 0.61) / 24;
const composed = `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${SIZE}" height="${SIZE}" rx="${Math.round(SIZE * 0.22)}" fill="${ACCENT}"/>
  <g transform="translate(${SIZE / 2} ${SIZE / 2}) scale(${scale}) translate(-12 -12)"
     fill="none" stroke="${GLYPH}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="${markPath}"/>
  </g>
</svg>`;

mkdirSync(ICONS_DIR, { recursive: true });

const png = await sharp(Buffer.from(composed)).png().toBuffer();
writeFileSync(MASTER_PNG, png);
console.log(`wrote ${MASTER_PNG} (${png.length} bytes)`);

// `tauri icon` ships as a prebuilt binary in @tauri-apps/cli — it needs no
// Rust toolchain, so icon generation works on a machine set up only for web
// development.
console.log("running `tauri icon` to produce .ico/.icns/PNG ladder…");
execFileSync("npx", ["--no-install", "tauri", "icon", MASTER_PNG, "--output", ICONS_DIR], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log("desktop icons written to src-tauri/icons/");
