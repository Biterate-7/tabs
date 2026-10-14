import { scopedKey } from "./namespace";
import { forgetLegacyProjectEvents, legacyProjectEvents } from "@/lib/projects/activity";

/**
 * What the removed AI agent features left on this device, for the person to
 * keep or delete.
 *
 * Hubble used to run AI agents (a "Command Centre"). Removing that product
 * removed its code, not the person's records: agent runs and their logs,
 * sessions, authorized project folders, connected agents, each project's
 * last task and the agent entries in project history may still be in this
 * browser. Nothing reads or writes them now. Rather than delete them
 * silently on upgrade, Settings → Data says they are there, offers them as a
 * JSON download, and deletes them only when asked.
 *
 * Only the active account's partition is touched (scopedKey), exactly as
 * every other local store.
 */

export const LEGACY_AGENT_KEYS = [
  "tabdump:agents:v1",
  "tabdump:agent-sessions:v1",
  "tabdump:agent-projects:v1",
  "tabdump:agent-roster:v1",
  "tabdump:agent-last-task:v1",
  "tabdump:agent-layout:v1",
  "tabdump:connectors:v1",
  "tabdump:claude-code-mapping:v1",
] as const;

export type LegacyAgentData = {
  /** Keys present, and how many characters they hold. */
  keys: { key: string; chars: number }[];
  /** Agent entries in project history. */
  projectEvents: number;
  chars: number;
};

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(scopedKey(key));
  } catch {
    return null;
  }
}

export function findLegacyAgentData(): LegacyAgentData {
  const keys: LegacyAgentData["keys"] = [];
  for (const key of LEGACY_AGENT_KEYS) {
    const value = read(key);
    if (value !== null) keys.push({ key, chars: value.length });
  }
  const projectEvents = legacyProjectEvents().length;
  return { keys, projectEvents, chars: keys.reduce((sum, entry) => sum + entry.chars, 0) };
}

export function hasLegacyAgentData(data: LegacyAgentData = findLegacyAgentData()): boolean {
  return data.keys.length > 0 || data.projectEvents > 0;
}

/** Everything, as one JSON document the person can keep. Values are parsed when they parse, kept as text when not. */
export function exportLegacyAgentData(now: Date = new Date()): string {
  const storage: Record<string, unknown> = {};
  for (const key of LEGACY_AGENT_KEYS) {
    const value = read(key);
    if (value === null) continue;
    try {
      storage[key] = JSON.parse(value);
    } catch {
      storage[key] = value;
    }
  }
  return JSON.stringify(
    {
      kind: "hubble-legacy-agent-data",
      version: 1,
      exportedAt: now.toISOString(),
      note: "Records from Hubble's removed AI agent features (Command Centre). Hubble no longer reads these.",
      storage,
      projectHistory: legacyProjectEvents(),
    },
    null,
    2
  );
}

/** Deletes them all from this account's partition. Returns how many records went. */
export function deleteLegacyAgentData(): number {
  let removed = 0;
  for (const key of LEGACY_AGENT_KEYS) {
    try {
      const scoped = scopedKey(key);
      if (window.localStorage.getItem(scoped) !== null) {
        window.localStorage.removeItem(scoped);
        removed += 1;
      }
    } catch {
      // Storage unavailable: nothing could be removed, and the next look says so.
    }
  }
  return removed + forgetLegacyProjectEvents();
}
