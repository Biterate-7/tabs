import "server-only";
import { generateContent, generateContentStream } from "@/lib/ai/gemini/client";
import { chatModel, analysisModel } from "@/lib/ai/config";
import type { GeminiContent, GeminiResult } from "@/lib/ai/gemini/types";

export const runtime = "nodejs";

const MAX_CONTEXT_ITEMS = 12;
const MAX_CONTEXT_CHARS = 600;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 800;
const MAX_QUESTION_CHARS = 500;
const CHAT_MAX_OUTPUT_TOKENS = 1024;
const ANALYSIS_MAX_OUTPUT_TOKENS = 2048;

type ContextItem = { tabId: string; title: string; url: string; text: string };
type HistoryItem = { role: "user" | "model"; text: string };
type Mode = "chat" | "collection-overview" | "collection-gaps";

const MODES: Mode[] = ["chat", "collection-overview", "collection-gaps"];

const ERROR_STATUS: Record<string, number> = {
  "missing-key": 503,
  "rate-limited": 429,
  "network-error": 502,
  "gemini-error": 502,
  "malformed-response": 502,
};

const ERROR_MESSAGE: Record<string, string> = {
  "missing-key": "AI features aren't configured yet.",
  "rate-limited": "Too many requests right now — try again shortly.",
  "network-error": "Couldn't reach the AI service.",
  "gemini-error": "The AI service returned an error.",
  "malformed-response": "The AI service returned something we couldn't parse.",
};

const CHAT_SYSTEM_INSTRUCTION = `You are Ask TabDump, an assistant that answers questions using ONLY the "Saved context" the user provides below — their own saved browser tabs. Never use outside knowledge, and never invent a fact, URL, or title that isn't in the given context.

If the context doesn't contain enough information to answer, reply with exactly: "I couldn't find enough information in your saved tabs to answer that." Otherwise answer concisely and naturally, referring to the saved items in plain language (e.g. "your saved article on X says..."). Do not output the [N] index markers themselves in your reply — they're only for your own reference.`;

const OVERVIEW_SYSTEM_INSTRUCTION = `You analyze a user's saved TabDump tabs (given as numbered "Saved context" items) and summarize them. Base everything strictly on the given items — never invent tabs, themes, or facts not supported by them. "importantResourceIndexes" must only contain the [N] numbers of items you found genuinely useful/representative.`;

const GAPS_SYSTEM_INSTRUCTION = `You analyze a user's saved TabDump tabs (given as numbered "Saved context" items) to suggest what topics look well-covered vs. under-researched. This is only a suggestion based on what they happened to save, not an objective judgment of the subject — phrase gaps tentatively ("you may be missing...", "consider looking into...").`;

// Gemini's responseSchema uses its protobuf-derived Type enum, which is
// UPPERCASE ("OBJECT"/"STRING"/"ARRAY"/"INTEGER") — not JSON Schema's
// lowercase convention. A lowercase type here is rejected by the API with a
// 400, which is a real bug this fixes (see commit for the diagnosis).
const OVERVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    overview: { type: "STRING" },
    themes: { type: "ARRAY", items: { type: "STRING" } },
    importantResourceIndexes: { type: "ARRAY", items: { type: "INTEGER" } },
    keyInsights: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["overview", "themes", "importantResourceIndexes", "keyInsights"],
};

const GAPS_SCHEMA = {
  type: "OBJECT",
  properties: {
    covered: { type: "ARRAY", items: { type: "STRING" } },
    gaps: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["covered", "gaps"],
};

function isContextArray(value: unknown): value is ContextItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof (v as ContextItem).tabId === "string" &&
        typeof (v as ContextItem).title === "string" &&
        typeof (v as ContextItem).url === "string" &&
        typeof (v as ContextItem).text === "string"
    )
  );
}

function isHistoryArray(value: unknown): value is HistoryItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        (v as HistoryItem).role !== undefined &&
        ["user", "model"].includes((v as HistoryItem).role) &&
        typeof (v as HistoryItem).text === "string"
    )
  );
}

function buildContextBlock(context: ContextItem[]): string {
  return context
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(
      (item, i) =>
        `[${i + 1}] Title: ${item.title}\nURL: ${item.url}\n${item.text.slice(0, MAX_CONTEXT_CHARS)}`
    )
    .join("\n\n");
}

function errorResponse(failure: Extract<GeminiResult<unknown>, { ok: false }>): Response {
  return Response.json(
    { error: ERROR_MESSAGE[failure.reason], detail: failure.detail },
    { status: ERROR_STATUS[failure.reason] }
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const b = body as Record<string, unknown> | null;
  const mode = (b?.mode as Mode | undefined) ?? "chat";
  const question = b?.question;
  const context = b?.context;
  const history = b?.history ?? [];

  if (!MODES.includes(mode)) {
    return Response.json({ error: "Invalid mode." }, { status: 400 });
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    return Response.json({ error: "Expected a non-empty { question: string }." }, { status: 400 });
  }
  if (!isContextArray(context)) {
    return Response.json({ error: "Expected { context: {tabId,title,url,text}[] }." }, { status: 400 });
  }
  if (!isHistoryArray(history)) {
    return Response.json({ error: "Expected { history: {role,text}[] }." }, { status: 400 });
  }

  const contextBlock = buildContextBlock(context);
  const cappedQuestion = question.slice(0, MAX_QUESTION_CHARS);
  const prompt = `Saved context:\n${contextBlock || "(no saved tabs matched this question)"}\n\nUser question: ${cappedQuestion}`;

  const historyContents: GeminiContent[] = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((h) => ({ role: h.role, text: h.text.slice(0, MAX_HISTORY_CHARS) }));

  if (mode === "chat") {
    const result = await generateContentStream({
      model: chatModel(),
      systemInstruction: CHAT_SYSTEM_INSTRUCTION,
      contents: [...historyContents, { role: "user", text: prompt }],
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    });

    if (!result.ok) return errorResponse(result);

    return new Response(result.data, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const isOverview = mode === "collection-overview";
  const result = await generateContent({
    model: analysisModel(),
    systemInstruction: isOverview ? OVERVIEW_SYSTEM_INSTRUCTION : GAPS_SYSTEM_INSTRUCTION,
    contents: [{ role: "user", text: prompt }],
    maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
    responseSchema: isOverview ? OVERVIEW_SCHEMA : GAPS_SCHEMA,
  });

  if (!result.ok) return errorResponse(result);

  try {
    const parsed = JSON.parse(result.data);
    return Response.json({ result: parsed });
  } catch (err) {
    return errorResponse({
      ok: false,
      reason: "malformed-response",
      detail: err instanceof Error ? err.message : "model output wasn't valid JSON",
    });
  }
}
