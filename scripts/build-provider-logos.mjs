// Generates the in-app AI provider logos from the supplied originals in
// brand/providers/. The originals are kept byte-for-byte as delivered;
// nothing here redraws or recolours a logo.
//
// Run with: npm run brand:providers
//
// Each output is the original resized to 128px (the UI draws them at 12-16px,
// so this covers 3x displays without shipping a 960px bitmap per icon).
//
//   claude, gemini, perplexity   resized as they are.
//   chatgpt                      the supplied file is a black logo on an opaque
//                                white square. A white square cannot sit on a
//                                themed surface, so the white is turned into
//                                transparency: the logo's own pixels become the
//                                alpha channel (antialiasing included) and the
//                                shape is unchanged. ProviderMark paints this
//                                alpha with the theme's foreground colour, so the
//                                one-colour mark stays visible on every theme.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "brand", "providers");
const OUT_DIR = path.join(ROOT, "public", "brand", "providers");
const SIZE = 128;

const source = (id) => path.join(SOURCE_DIR, `${id}.png`);
mkdirSync(OUT_DIR, { recursive: true });

async function resized(id) {
  return sharp(source(id)).resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer();
}

for (const id of ["claude", "gemini", "perplexity"]) {
  writeFileSync(path.join(OUT_DIR, `${id}.png`), await resized(id));
}

// ChatGPT: luminance → alpha, colour left black.
const { data, info } = await sharp(source("chatgpt")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const rgba = Buffer.alloc(info.width * info.height * 4);
for (let i = 0; i < info.width * info.height; i++) {
  rgba[i * 4 + 3] = 255 - data[i * 3]; // the file is greyscale: R = G = B
}
const mask = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(path.join(OUT_DIR, "chatgpt.png"), mask);

console.log(`Wrote 4 provider logos to ${path.relative(ROOT, OUT_DIR)}`);
