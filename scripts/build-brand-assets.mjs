// Generates every Hubble logo asset from ONE source: brand/hubble-logo-source.webp,
// the supplied Hubble logo, kept byte-for-byte as delivered. Nothing here
// redraws the mark. Each output is a square crop of that image, centred on
// the mark, resized, and (for icon targets) given rounded corners. The web
// favicon, the extension toolbar icons and the desktop app icon therefore
// cannot drift apart visually.
//
// Run with: npm run brand:assets
//
// Two crops are used:
//   - "tile": the mark fills 78% of the square. Large icons (desktop app,
//     Apple touch icon, Open Graph) where platform masks and rounded corners
//     need breathing room.
//   - "compact": the mark fills 88%. Favicon, small extension icons and the
//     in-app mark, where every pixel at 16-32px matters.
//
// The desktop step renders a 1024px master and hands it to the Tauri CLI,
// which writes the platform containers (.ico, .icns, the PNG ladder) that
// sharp cannot.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "brand", "hubble-logo-source.webp");

const TILE_FILL = 0.78;
const COMPACT_FILL = 0.88;
const CORNER_RADIUS = 0.22;

const out = (...segments) => path.join(ROOT, ...segments);

// ─── Locate the mark and the background colour in the source ────────────────

const { data, info } = await sharp(SOURCE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const lum = (x, y) => data[(y * W + x) * 3];

// Anything well above the near-black background is part of the mark.
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (lum(x, y) > 60) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX <= minX || maxY <= minY) throw new Error(`No logo found in ${SOURCE}`);

const centreX = (minX + maxX) / 2;
const centreY = (minY + maxY) / 2;
const markExtent = Math.max(maxX - minX, maxY - minY);

// The source's own background, sampled from its top-left corner, fills any
// area a crop needs beyond the image edge so the tile stays seamless.
const background = { r: data[0], g: data[1], b: data[2], alpha: 1 };

/** A square crop of the source in which the mark spans `fill` of the side. */
async function crop(fill) {
  const side = Math.round(markExtent / fill);
  const left = Math.round(centreX - side / 2);
  const top = Math.round(centreY - side / 2);
  const pad = {
    left: Math.max(0, -left),
    top: Math.max(0, -top),
    right: Math.max(0, left + side - W),
    bottom: Math.max(0, top + side - H),
  };
  const extended = await sharp(SOURCE)
    .removeAlpha()
    .extend({ ...pad, background })
    .toBuffer();
  return sharp(extended)
    .extract({ left: left + pad.left, top: top + pad.top, width: side, height: side })
    .png()
    .toBuffer();
}

const tile = await crop(TILE_FILL);
const compact = await crop(COMPACT_FILL);

/** Resize a square crop; `rounded` clips it to the brand's rounded tile. */
async function render(source, size, { rounded }) {
  const resized = sharp(source).resize(size, size, { kernel: "lanczos3" });
  if (!rounded) return resized.png().toBuffer();
  const r = Math.round(size * CORNER_RADIUS);
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`
  );
  return sharp(await resized.png().toBuffer())
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

function write(file, buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buffer);
  console.log(`wrote ${path.relative(ROOT, file)} (${buffer.length} bytes)`);
}

/** A PNG-framed .ico (the format every current browser and Windows accepts). */
function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

// ─── Web app ─────────────────────────────────────────────────────────────────

const faviconFrames = [];
for (const size of [16, 32, 48]) {
  faviconFrames.push({ size, png: await render(compact, size, { rounded: true }) });
}
write(out("src", "app", "favicon.ico"), ico(faviconFrames));
write(out("src", "app", "icon.png"), await render(compact, 512, { rounded: true }));
// iOS applies its own mask, and shows transparency as black: full bleed.
write(out("src", "app", "apple-icon.png"), await render(tile, 180, { rounded: false }));
// The in-app mark (sidebar, sign-in). Square; CSS rounds it at display size.
write(out("public", "brand", "hubble-mark.png"), await render(compact, 128, { rounded: false }));

// Open Graph / social preview: the tile centred on the source's own background.
const ogTile = await render(tile, 630, { rounded: false });
write(
  out("src", "app", "opengraph-image.png"),
  await sharp({ create: { width: 1200, height: 630, channels: 3, background } })
    .composite([{ input: ogTile, left: 285, top: 0 }])
    .png()
    .toBuffer()
);

// ─── Browser extension ───────────────────────────────────────────────────────

for (const size of [16, 32, 48, 128]) {
  const source = size <= 32 ? compact : tile;
  write(out("extension", "icons", `icon${size}.png`), await render(source, size, { rounded: true }));
}

// ─── Desktop (Tauri) ─────────────────────────────────────────────────────────

const master = out("src-tauri", "icons", "icon.png");
write(master, await render(tile, 1024, { rounded: true }));

if (process.argv.includes("--skip-desktop-containers")) {
  console.log("skipping `tauri icon` (--skip-desktop-containers)");
} else {
  // `tauri icon` ships as a prebuilt binary in @tauri-apps/cli, so this needs
  // no Rust toolchain.
  console.log("running `tauri icon` to produce .ico/.icns/PNG ladder…");
  execFileSync("npx", ["--no-install", "tauri", "icon", master, "--output", out("src-tauri", "icons")], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  // `tauri icon` also writes mobile sets; this app only bundles for desktop.
  for (const mobile of ["android", "ios"]) {
    rmSync(out("src-tauri", "icons", mobile), { recursive: true, force: true });
  }
}
