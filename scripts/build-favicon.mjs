// One-off script to rasterize src/app/icon.svg into a multi-resolution
// favicon.ico (PNG-compressed frames, the modern ICO format all browsers
// and Windows Vista+ support) using the sharp already present in
// node_modules — avoids adding a new dependency just for this.
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const svgPath = path.resolve("src/app/icon.svg");
const outPath = path.resolve("src/app/favicon.ico");
const svg = readFileSync(svgPath);
const sizes = [16, 32, 48];

const pngBuffers = [];
for (const size of sizes) {
  const buf = await sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();
  pngBuffers.push({ size, buf });
}

// ICO header: 6 bytes, then one 16-byte directory entry per image.
const headerSize = 6 + 16 * pngBuffers.length;
let offset = headerSize;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngBuffers.length, 4); // image count

pngBuffers.forEach(({ size, buf }, i) => {
  const entryOffset = 6 + i * 16;
  header.writeUInt8(size === 256 ? 0 : size, entryOffset); // width
  header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1); // height
  header.writeUInt8(0, entryOffset + 2); // color palette
  header.writeUInt8(0, entryOffset + 3); // reserved
  header.writeUInt16LE(1, entryOffset + 4); // color planes
  header.writeUInt16LE(32, entryOffset + 6); // bits per pixel
  header.writeUInt32LE(buf.length, entryOffset + 8); // image data size
  header.writeUInt32LE(offset, entryOffset + 12); // image data offset
  offset += buf.length;
});

const ico = Buffer.concat([header, ...pngBuffers.map((p) => p.buf)]);
writeFileSync(outPath, ico);
console.log(`wrote ${outPath} (${ico.length} bytes, sizes: ${sizes.join(", ")})`);
