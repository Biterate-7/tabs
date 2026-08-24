import { describe, expect, it } from "vitest";
import { stripSpuriousMarkdownEscapes } from "./unescape";

describe("stripSpuriousMarkdownEscapes", () => {
  it("un-escapes a backslash-escaped bold marker", () => {
    expect(stripSpuriousMarkdownEscapes("\\*\\*TabDump Development & Hosting:\\*\\*")).toBe(
      "**TabDump Development & Hosting:**"
    );
  });

  it("un-escapes a backslash-escaped inline code marker", () => {
    expect(stripSpuriousMarkdownEscapes("\\`tabdump\\`")).toBe("`tabdump`");
  });

  it("un-escapes a backslash-escaped heading marker", () => {
    expect(stripSpuriousMarkdownEscapes("\\#\\#\\# 1. TabDump Development")).toBe("### 1. TabDump Development");
  });

  it("un-escapes the full reported bug reproduction", () => {
    const input =
      'Your query was cut off at \\*"Summarize what I\'ve saved about..."\\*, but here is a breakdown...\n\n---\n\n\\#\\#\\# 1. \\*\\*TabDump Development & Hosting\\*\\*\n\n\\* \\*\\*Vercel Deployments & Previews:\\*\\* Multiple deployment overview pages...';
    const output = stripSpuriousMarkdownEscapes(input);
    expect(output).not.toContain("\\*");
    expect(output).not.toContain("\\#");
    expect(output).toContain("### 1. **TabDump Development & Hosting**");
  });

  it("leaves text with no escapes unchanged", () => {
    const plain = "A plain sentence with **bold**, `code`, and no backslashes.";
    expect(stripSpuriousMarkdownEscapes(plain)).toBe(plain);
  });

  it("does not touch a backslash that isn't immediately followed by a Markdown character", () => {
    const path = "C:\\Users\\me\\file.txt";
    expect(stripSpuriousMarkdownEscapes(path)).toBe(path);
  });
});
