import { describe, expect, it } from "vitest";
import { extractGoogleWorkspaceFile } from "./workspace-url";

describe("extractGoogleWorkspaceFile", () => {
  it("extracts a Google Docs file id", () => {
    expect(
      extractGoogleWorkspaceFile("https://docs.google.com/document/d/1abc123/edit")
    ).toEqual({ fileId: "1abc123", docType: "document" });
  });

  it("extracts a Google Sheets file id", () => {
    expect(
      extractGoogleWorkspaceFile(
        "https://docs.google.com/spreadsheets/d/1abc123/edit#gid=0"
      )
    ).toEqual({ fileId: "1abc123", docType: "spreadsheet" });
  });

  it("extracts a Google Slides file id", () => {
    expect(
      extractGoogleWorkspaceFile(
        "https://docs.google.com/presentation/d/1abc123/edit"
      )
    ).toEqual({ fileId: "1abc123", docType: "presentation" });
  });

  it("extracts a file id with no trailing path", () => {
    expect(
      extractGoogleWorkspaceFile("https://docs.google.com/document/d/1abc123")
    ).toEqual({ fileId: "1abc123", docType: "document" });
  });

  it("returns null for a non-Google URL", () => {
    expect(extractGoogleWorkspaceFile("https://example.com/document/d/1abc123")).toBeNull();
  });

  it("returns null for drive.google.com (folders/other Drive links, out of scope)", () => {
    expect(
      extractGoogleWorkspaceFile("https://drive.google.com/drive/folders/1abc123")
    ).toBeNull();
  });

  it("returns null for an unsupported docs.google.com path (e.g. Forms)", () => {
    expect(
      extractGoogleWorkspaceFile("https://docs.google.com/forms/d/1abc123/edit")
    ).toBeNull();
  });

  it("returns null for a malformed URL without throwing", () => {
    expect(() => extractGoogleWorkspaceFile("not a url")).not.toThrow();
    expect(extractGoogleWorkspaceFile("not a url")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractGoogleWorkspaceFile("")).toBeNull();
  });
});
