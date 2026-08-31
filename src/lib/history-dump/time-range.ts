import type { HistoryTimeRangeId } from "./types";

export type CustomHistoryRange = { startTime: number; endTime: number };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Turns a chosen range option into a concrete `[startTime, endTime]` in
 * epoch ms, the shape get_history's extension command expects. `now`/`custom`
 * are parameters (not read from Date.now()/state internally) purely so this
 * stays a pure, trivially-testable function — callers pass real values.
 *
 * "Today"/"3 days"/etc. all end at `now` (an open-ended upper bound, not
 * end-of-today) — there is no reason to exclude history from the last few
 * minutes just because the calendar day hasn't rolled over.
 */
export function resolveTimeRange(
  id: HistoryTimeRangeId,
  now: number,
  custom?: CustomHistoryRange
): { startTime: number; endTime: number } {
  switch (id) {
    case "today":
      return { startTime: startOfDay(now), endTime: now };
    case "3d":
      return { startTime: now - 3 * DAY_MS, endTime: now };
    case "7d":
      return { startTime: now - 7 * DAY_MS, endTime: now };
    case "30d":
      return { startTime: now - 30 * DAY_MS, endTime: now };
    case "custom": {
      if (!custom || custom.endTime < custom.startTime) return { startTime: now - 7 * DAY_MS, endTime: now };
      return { startTime: custom.startTime, endTime: custom.endTime };
    }
  }
}
