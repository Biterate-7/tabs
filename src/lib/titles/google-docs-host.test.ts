import { describe, expect, it } from "vitest";
import { isGoogleDocsHostname, stripGoogleDocsSuffix } from "./google-docs-host";

describe("isGoogleDocsHostname", () => {
  it("matches docs.google.com and drive.google.com, case-insensitively", () => {
    expect(isGoogleDocsHostname("docs.google.com")).toBe(true);
    expect(isGoogleDocsHostname("drive.google.com")).toBe(true);
    expect(isGoogleDocsHostname("DOCS.GOOGLE.COM")).toBe(true);
  });

  it("does not match unrelated Google hosts", () => {
    expect(isGoogleDocsHostname("www.google.com")).toBe(false);
    expect(isGoogleDocsHostname("mail.google.com")).toBe(false);
    expect(isGoogleDocsHostname("example.com")).toBe(false);
  });
});

describe("stripGoogleDocsSuffix", () => {
  it("strips the Docs/Sheets/Slides/Forms/Drawings suffix variants", () => {
    expect(stripGoogleDocsSuffix("My Research Paper - Google Docs")).toBe("My Research Paper");
    expect(stripGoogleDocsSuffix("Q3 Budget - Google Sheets")).toBe("Q3 Budget");
    expect(stripGoogleDocsSuffix("Pitch Deck - Google Slides")).toBe("Pitch Deck");
    expect(stripGoogleDocsSuffix("Signup Form - Google Forms")).toBe("Signup Form");
    expect(stripGoogleDocsSuffix("Sketch - Google Drawings")).toBe("Sketch");
  });

  it("handles an en dash separator too", () => {
    expect(stripGoogleDocsSuffix("Budget – Google Sheets")).toBe("Budget");
  });

  it("leaves a title with no matching suffix untouched", () => {
    expect(stripGoogleDocsSuffix("Google Docs")).toBe("Google Docs");
    expect(stripGoogleDocsSuffix("My Research Paper")).toBe("My Research Paper");
  });
});
