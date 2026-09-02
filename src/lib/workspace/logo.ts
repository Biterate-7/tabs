/**
 * Client-side processing for user-uploaded workspace logos: validates the
 * source file, then (for raster formats) downsizes and compresses it via
 * canvas before it's stored as a data URL directly on the Workspace object
 * (see types.ts). Kept dependency-free — no image library, just the
 * browser's own <img>/<canvas> APIs — since the whole image only ever needs
 * to become a small localStorage-friendly data URL.
 */

const ACCEPTED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

/** Raw upload cap, checked before any processing — rejects absurdly large files fast. */
export const LOGO_MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/** Cap on the final stored data URL's string length (~530KB of binary image data at base64's ~4/3 overhead) — keeps a single logo from meaningfully denting localStorage's ~5-10MB budget. */
export const LOGO_MAX_DATA_URL_LENGTH = 700_000;

/** Longest edge a raster logo is resized to; aspect ratio is preserved, not cropped — see fitLogoDimensions. */
export const LOGO_MAX_DIMENSION = 512;

export type LogoProcessResult = { ok: true; dataUrl: string } | { ok: false; error: string };

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

/**
 * Pure size/type validation, split out from processLogoFile so it's testable
 * without touching canvas/Image (unavailable in most test environments).
 */
export function validateLogoFile(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_LOGO_TYPES.has(file.type)) {
    return "Please upload a PNG, JPG, WEBP, or SVG image.";
  }
  if (file.size > LOGO_MAX_SOURCE_BYTES) {
    return `That image is too large (max ${formatMb(LOGO_MAX_SOURCE_BYTES)}).`;
  }
  return null;
}

/**
 * Scales `width`×`height` down to fit within `max` on its longest edge,
 * preserving aspect ratio. Returns the original dimensions unchanged when
 * already within bounds — never upscales a small image. Pure/testable.
 */
export function fitLogoDimensions(
  width: number,
  height: number,
  max: number = LOGO_MAX_DIMENSION
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: max, height: max };
  if (width <= max && height <= max) return { width, height };
  const scale = Math.min(max / width, max / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Loose shape check for a value that should be a workspace logo data URL — used to sanitize imported/hand-edited exports without trusting their content. */
export function isValidLogoDataUrl(value: string): boolean {
  return /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(value) && value.length <= LOGO_MAX_DATA_URL_LENGTH;
}

function readAsImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("invalid-image"));
    };
    img.src = url;
  });
}

function rasterize(img: HTMLImageElement, quality: number): string | null {
  const { width, height } = fitLogoDimensions(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/webp", quality);
}

/**
 * SVGs are vector, so they're stored as-is (base64-encoded) rather than
 * rasterized — just size-capped like everything else. `<img>`/data-URL
 * rendering never executes embedded scripts, but a `<script>` element is
 * rejected anyway as defense in depth against a pasted/renamed non-SVG file.
 */
async function processSvg(file: File): Promise<LogoProcessResult> {
  const text = await file.text();
  if (/<script[\s>]/i.test(text)) {
    return { ok: false, error: "That SVG contains a <script> element and can't be used." };
  }
  const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  if (dataUrl.length > LOGO_MAX_DATA_URL_LENGTH) {
    return { ok: false, error: "That image is too large to store, even after processing." };
  }
  return { ok: true, dataUrl };
}

/**
 * Validates, then (for raster formats) resizes to at most
 * LOGO_MAX_DIMENSION and compresses via canvas, retrying at lower quality
 * until the result fits LOGO_MAX_DATA_URL_LENGTH. Returns a user-facing
 * error string on any failure — never throws.
 */
export async function processLogoFile(file: File): Promise<LogoProcessResult> {
  const validationError = validateLogoFile(file);
  if (validationError) return { ok: false, error: validationError };

  if (file.type === "image/svg+xml") return processSvg(file);

  let img: HTMLImageElement;
  try {
    img = await readAsImage(file);
  } catch {
    return { ok: false, error: "Couldn't read that image file." };
  }

  try {
    for (const quality of [0.85, 0.6, 0.4]) {
      const dataUrl = rasterize(img, quality);
      if (!dataUrl) return { ok: false, error: "Your browser can't process images here." };
      if (dataUrl.length <= LOGO_MAX_DATA_URL_LENGTH) return { ok: true, dataUrl };
    }
    return { ok: false, error: "That image is too large to store, even after compression." };
  } finally {
    URL.revokeObjectURL(img.src);
  }
}
