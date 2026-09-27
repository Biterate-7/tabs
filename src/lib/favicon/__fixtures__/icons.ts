/** Minimal but genuine-format icon bodies for the resolver's tests. */

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** ICONDIR with one entry. */
export const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 16, 16, 0, 0, 1, 0, 32, 0]);

export const SVG = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16"/></svg>`
);

export const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
export const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1");

/** The kind of 200 response a soft-404 /favicon.ico really is. */
export const HTML_ERROR_PAGE = Buffer.from(
  `<!DOCTYPE html><html><head><title>Not found</title></head><body><svg viewBox="0 0 1 1"></svg>Page not found</body></html>`
);
