export type GoogleWorkspaceDocType = "document" | "spreadsheet" | "presentation";

export type GoogleWorkspaceFile = {
  fileId: string;
  docType: GoogleWorkspaceDocType;
};

const PATH_PATTERN = /^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/;

export function extractGoogleWorkspaceFile(url: string): GoogleWorkspaceFile | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== "docs.google.com") return null;

  const match = PATH_PATTERN.exec(parsed.pathname);
  if (!match) return null;

  const [, segment, fileId] = match;
  const docType: GoogleWorkspaceDocType =
    segment === "document" ? "document" : segment === "spreadsheets" ? "spreadsheet" : "presentation";

  return { fileId, docType };
}
