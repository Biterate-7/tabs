import { parseConversationExport } from "./exports";
import { CONVERSATION_LIMITS } from "./types";
import type { ExportFormat } from "./exports";
import type { ConversationInput } from "./types";
import type { AiProviderId } from "@/lib/providers/registry";

/**
 * A file a person chose to import into a project, read and recognised.
 *
 *   .json        an AI app's conversation export (ChatGPT or Claude) —
 *                anything else is refused with a reason
 *   .md / .txt   text: a conversation saved as Markdown (Perplexity's own
 *                thread export, for one) or notes; the caller saves it as a
 *                pasted conversation or a note
 *
 * Checked before it is read: the size (an export of years of chats can be
 * large; past the bound it is refused rather than freezing the page) and the
 * type. A zipped export is refused with the step that fixes it.
 */

export type ImportFileFailure = "too-large" | "unsupported-type" | "zip" | "unreadable" | "malformed-json" | "unknown-format" | "empty";

export type ImportFileResult =
  | { ok: true; kind: "export"; format: ExportFormat; provider: AiProviderId; conversations: ConversationInput[]; skipped: number; truncated: boolean }
  | { ok: true; kind: "text"; text: string; fileName: string }
  | { ok: false; reason: ImportFileFailure };

export const IMPORT_FILE_MESSAGES: Record<ImportFileFailure, string> = {
  "too-large": `That file is larger than ${Math.round(CONVERSATION_LIMITS.importBytes / (1024 * 1024))} MB. Import a smaller export.`,
  "unsupported-type": "Hubble can import a ChatGPT or Claude conversations.json, or a .md or .txt file.",
  zip: "That's the zipped export. Unzip it first, then choose conversations.json from inside.",
  unreadable: "That file couldn't be read. Try choosing it again.",
  "malformed-json": "That file isn't valid JSON, so nothing was imported.",
  "unknown-format": "That JSON isn't a ChatGPT or Claude conversation export, so nothing was imported. Gemini and Perplexity exports aren't supported — save those conversations from the page, or paste them.",
  empty: "That file has no conversations Hubble could read.",
};

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt"]);

export type ImportableFile = { name: string; size: number; text: () => Promise<string> };

export async function readImportFile(file: ImportableFile): Promise<ImportFileResult> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "zip") return { ok: false, reason: "zip" };
  if (extension !== "json" && !TEXT_EXTENSIONS.has(extension)) return { ok: false, reason: "unsupported-type" };
  if (file.size > CONVERSATION_LIMITS.importBytes) return { ok: false, reason: "too-large" };

  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    if (raw.trim().length === 0) return { ok: false, reason: "empty" };
    return { ok: true, kind: "text", text: raw, fileName: file.name };
  }

  const parsed = parseConversationExport(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, kind: "export", format: parsed.format, provider: parsed.provider, conversations: parsed.conversations, skipped: parsed.skipped, truncated: parsed.truncated };
}
