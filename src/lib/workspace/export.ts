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

export function downloadTextFile(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
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
