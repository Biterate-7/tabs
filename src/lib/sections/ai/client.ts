import { formatApiError } from "@/lib/ai/types";

export type OrganizeApiResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Posts one organize prompt to /api/ai/organize. Callers (src/lib/sections/ai/organize.ts) handle chunking, validation, and the deterministic fallback — this only handles the network round trip. */
export async function requestOrganizeCompletion(prompt: string): Promise<OrganizeApiResult> {
  try {
    const response = await fetch("/api/ai/organize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return { ok: false, error: formatApiError(data, response.status) };
    }
    if (!data || !("data" in data)) {
      return { ok: false, error: "Malformed organize response." };
    }
    return { ok: true, data: (data as { data: unknown }).data };
  } catch (err) {
    const detail = err instanceof Error ? err.message : undefined;
    return { ok: false, error: detail ? `Couldn't reach the organize service. (${detail})` : "Couldn't reach the organize service." };
  }
}
