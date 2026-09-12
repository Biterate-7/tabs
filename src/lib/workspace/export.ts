import { saveTextFile } from "@/lib/platform";
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories";
import type { Tab } from "@/lib/tabs/types";
import { groupByCategory } from "./stats";

export function urlsText(tabs: Tab[]): string {
  return tabs.map((t) => t.url).join("\n");
}

export function buildExportText(tabs: Tab[]): string {
  const groups = groupByCategory(tabs);
  const lines: string[] = ["TABDUMP EXPORT", ""];

  for (const id of CATEGORY_ORDER) {
    const group = groups[id];
    if (group.length === 0) continue;
    lines.push(CATEGORIES[id].name.toUpperCase());
    lines.push("");
    for (const tab of group) {
      lines.push(tab.url);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves the workspace export as a .txt the user keeps.
 *
 * The name is historical and still accurate on the web, where this is a
 * browser download. On the desktop app the platform layer routes it to a
 * native "Save as…" dialog instead, because a Tauri webview has no download
 * UI for a blob URL to land in — see src/lib/platform/types.ts.
 *
 * Async since that desktop dialog is something the user interacts with:
 * `false` means nothing was written, which includes them cancelling.
 */
export function downloadTextFile(filename: string, text: string): Promise<boolean> {
  return saveTextFile(filename, text, "text/plain;charset=utf-8");
}
