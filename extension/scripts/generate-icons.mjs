// Rasterizes the TabDump logo (src/app/icon.svg — the same black-background,
// white-dumpster mark used for the web app's favicon) into the toolbar icon
// PNGs Chrome requires (extension icons must be bitmaps; MV3 has no SVG
// support here). Re-run with `node extension/scripts/generate-icons.mjs` any
// time the source SVG changes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(__dirname, "../icons");
const SOURCE_SVG = path.resolve(__dirname, "../../src/app/icon.svg");

const SIZES = [16, 32, 48, 128];

mkdirSync(ICONS_DIR, { recursive: true });

const svg = readFileSync(SOURCE_SVG);

for (const size of SIZES) {
  const png = await sharp(svg, { density: (size / 100) * 96 })
    .resize(size, size)
    .png()
    .toBuffer();
  const outPath = path.join(ICONS_DIR, `icon${size}.png`);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
