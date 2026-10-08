import { describe, expect, it } from "vitest";
import { drawablePageIcon, MAX_PAGE_ICON_DATA_CHARS, MAX_PAGE_ICON_URL_CHARS, readPageIcon } from "./page-icon";

const CHATGPT = "https://chatgpt.com/cdn/assets/favicon-l4nq08hd.svg";
const DRIVE = "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png";
const INLINE = "data:image/png;base64,iVBORw0KGgo=";

describe("readPageIcon", () => {
  it("keeps the addresses Chrome reports for real pages", () => {
    expect(readPageIcon(CHATGPT)).toBe(CHATGPT);
    expect(readPageIcon(DRIVE)).toBe(DRIVE);
    expect(readPageIcon("http://intranet.example/favicon.ico")).toBe("http://intranet.example/favicon.ico");
  });

  it("keeps a small inline image, of any common icon type", () => {
    expect(readPageIcon(INLINE)).toBe(INLINE);
    expect(readPageIcon("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E")).toBeDefined();
    expect(readPageIcon("data:image/x-icon;base64,AAAB")).toBeDefined();
  });

  it("drops anything that is not an icon Hubble may keep", () => {
    for (const raw of [
      undefined,
      null,
      42,
      "",
      "   ",
      "chrome://theme/IDR_EXTENSIONS_FAVICON",
      "javascript:alert(1)",
      "file:///C:/icon.png",
      "data:text/html,<script>alert(1)</script>",
      "data:image/png;base64,AA AA",
      "not a url",
    ]) {
      expect(readPageIcon(raw), String(raw)).toBeUndefined();
    }
  });

  it("drops icons too large to keep on a tab", () => {
    expect(readPageIcon(`https://example.com/${"a".repeat(MAX_PAGE_ICON_URL_CHARS)}`)).toBeUndefined();
    expect(readPageIcon(`data:image/png;base64,${"A".repeat(MAX_PAGE_ICON_DATA_CHARS)}`)).toBeUndefined();
  });
});

describe("drawablePageIcon", () => {
  it("draws Chrome's icon directly on the web", () => {
    expect(drawablePageIcon(CHATGPT, "web")).toBe(CHATGPT);
    expect(drawablePageIcon(INLINE, "web")).toBe(INLINE);
  });

  it("on desktop, draws only inline icons — the CSP has no remote img-src, so the resolver answers instead", () => {
    expect(drawablePageIcon(CHATGPT, "desktop")).toBeNull();
    expect(drawablePageIcon(INLINE, "desktop")).toBe(INLINE);
  });

  it("re-reads a stored value instead of trusting it", () => {
    expect(drawablePageIcon("javascript:alert(1)", "web")).toBeNull();
    expect(drawablePageIcon(undefined, "web")).toBeNull();
  });
});
