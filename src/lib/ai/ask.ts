import type { Tab } from "@/lib/tabs/types";
import { embedTexts } from "./embed-client";
import { retrieveRelevantChunks } from "./retrieve";
import type { AskMessage, AskSource } from "./types";

const MAX_HISTORY_MESSAGES = 6;
export const NOT_ENOUGH_INFO_MESSAGE = "I couldn't find enough information in your saved tabs to answer that.";

export type AskResult = { ok: true; text: string; sources: AskSource[] } | { ok: false; error: string };

function toSource(tab: Tab | undefined, fallback: { tabId: string; title: string; url: string }): AskSource {
  return {
    tabId: fallback.tabId,
    title: tab?.title?.trim() || fallback.title,
    url: tab?.url ?? fallback.url,
    domain: tab?.domain ?? new URL(fallback.url).hostname,
    category: tab?.category,
  };
}

/**
 * Answers `question` grounded in `workspaceId`'s indexed chunks. Retrieval
 * happens first and entirely client-side; if nothing relevant is indexed,
 * this returns the fixed "not enough information" message without ever
 * calling Gemini (spec Step 14, and a free cost-control win).
 */
export async function askQuestion(params: {
  workspaceId: string;
  tabs: Tab[];
  question: string;
  history: AskMessage[];
  onDelta?: (deltaText: string) => void;
  signal?: AbortSignal;
}): Promise<AskResult> {
  const { workspaceId, tabs, question, history, onDelta, signal } = params;

  const embedResult = await embedTexts([question]);
  if (!embedResult.ok) return { ok: false, error: embedResult.error };

  const chunks = await retrieveRelevantChunks(workspaceId, embedResult.embeddings[0]);
  if (chunks.length === 0) {
    return { ok: true, text: NOT_ENOUGH_INFO_MESSAGE, sources: [] };
  }

  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const context = chunks.map((c) => {
    const tab = tabById.get(c.tabId);
    return { tabId: c.tabId, title: tab?.title?.trim() || c.title, url: c.url, text: c.text };
  });
  const sources = chunks.map((c) => toSource(tabById.get(c.tabId), c));

  const trimmedHistory = history
    .filter((m) => !m.pending)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", text: m.text }));

  let response: Response;
  try {
    response = await fetch("/api/ai/ask", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chat", question, history: trimmedHistory, context }),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the AI service." };
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { ok: false, error: (data && data.error) || `Request failed (${response.status}).` };
  }

  if (!response.body) {
    const text = await response.text();
    return { ok: true, text, sources };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const delta = decoder.decode(value, { stream: true });
    text += delta;
    onDelta?.(delta);
  }

  return { ok: true, text, sources };
}
