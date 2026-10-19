// Copies the data files pdf.js needs to draw some PDFs into public/pdfjs, so
// Hubble serves them itself: the web app and the desktop app (a static
// export loaded from the app's own origin) both read them from /pdfjs/ and
// no PDF viewer ever fetches fonts or decoders from a third-party CDN.
//
//   cmaps/           text encodings for CJK PDFs that don't embed them
//   standard_fonts/  the 14 base PDF fonts, for PDFs that name but don't embed them
//   wasm/            JPEG 2000 / JBIG2 / colour decoders for scanned and image-heavy PDFs
//   iccs/            a colour profile
//
// Runs before `dev` and `build` (package.json predev/prebuild), so the copy
// can never drift from the installed pdfjs-dist version. public/pdfjs is
// generated and git-ignored; the worker itself is bundled by Next.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "node_modules", "pdfjs-dist");
const TARGET = path.join(ROOT, "public", "pdfjs");

if (!existsSync(SOURCE)) {
  console.error("[pdfjs-assets] pdfjs-dist is not installed. Run `npm install` first.");
  process.exit(1);
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  // pdf.js's PDF scripting engine is never started (enableScripting is off), so it isn't shipped.
  cpSync(path.join(SOURCE, directory), path.join(TARGET, directory), { recursive: true, filter: (file) => !path.basename(file).startsWith("quickjs") });
}
console.log("[pdfjs-assets] copied pdf.js data files to public/pdfjs");
