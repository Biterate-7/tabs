import type { Workspace } from "./types";

export const EXPORT_VERSION = 1;

export type WorkspaceExport = {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  workspaces: Workspace[];
};

export function buildWorkspaceExport(workspaces: Workspace[]): WorkspaceExport {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspaces,
  };
}

export function serializeWorkspaceExport(data: WorkspaceExport): string {
  return JSON.stringify(data, null, 2);
}

export function downloadJsonFile(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
