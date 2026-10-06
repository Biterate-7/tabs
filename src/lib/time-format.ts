/**
 * How Hubble says *when* something happened. The one formatter for every
 * agent surface — live activity, agent history, the session list, handoff
 * records, the Action Inspector and the landing page's demo — so the same
 * moment reads the same wherever it appears.
 *
 * Four shapes, each for one job:
 *
 *   formatRelativeTime   "Just now" · "5 min ago" · "2 hr ago" · "Yesterday" · "3 days ago" · "3 Oct"
 *   formatCompactTime    "now" · "5m" · "2h" · "3d" · "3 Oct"   (a narrow list column)
 *   formatDayLabel       "Today" · "Yesterday" · "Mon, 3 Oct"   (a heading over a day's rows)
 *   formatTimestamp      "Today 14:05" · "Yesterday 14:05" · "Mon, 3 Oct 14:05"   (a fixed record)
 *
 * ## The rules every shape keeps
 *
 * - **`now` is the caller's.** Nothing here reads the clock, so a render is a
 *   pure function of its props and a test pins the answer.
 * - **Singular and plural are never guessed.** "1 day ago", never "1 days ago".
 * - **The clock can disagree.** A record a little ahead of `now` — a server a
 *   few seconds fast, a runtime on another machine — is "Just now", not a
 *   blank and not "in 3 seconds". One far ahead is shown as the date it says,
 *   because pretending it is recent would be the lie.
 * - **Calendar days, not 24-hour blocks.** Something from 23:50 yesterday is
 *   "Yesterday" at 00:10 today, as a person would say it.
 * - **Locale-aware dates, fixed words.** Dates and clocks follow the person's
 *   locale; the relative words are Hubble's own.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How far ahead of `now` a record may be and still read as just now. */
const CLOCK_SKEW = 5 * MINUTE;
/** After this many calendar days, a relative phrase gives way to the date. */
const RELATIVE_DAYS = 7;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar days from `at` to `now`: 0 today, 1 yesterday, negative for a future day. */
export function calendarDaysBetween(at: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(at)) / (24 * HOUR));
}

function sameYear(at: number, now: number): boolean {
  return new Date(at).getFullYear() === new Date(now).getFullYear();
}

/** "3 Oct", or "3 Oct 2025" when it is not this year. */
export function formatDate(at: number, now: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear(at, now) ? {} : { year: "numeric" }),
  });
}

/** "14:05" — the person's own clock format. */
export function formatClockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function usable(at: number | undefined | null): at is number {
  // Zero is "never recorded" in every store Hubble reads, never 1 January 1970.
  return typeof at === "number" && Number.isFinite(at) && at > 0;
}

/**
 * How long ago, in words. `null` only for a timestamp that was never
 * recorded, so a caller can leave the slot out rather than print a blank.
 */
export function formatRelativeTime(at: number | undefined | null, now: number): string | null {
  if (!usable(at)) return null;
  const elapsed = now - at;
  if (elapsed < -CLOCK_SKEW) return formatTimestamp(at, now);
  if (elapsed < MINUTE) return "Just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  const days = calendarDaysBetween(at, now);
  if (days <= 0 || elapsed < 6 * HOUR) return `${Math.floor(elapsed / HOUR)} hr ago`;
  if (days === 1) return "Yesterday";
  if (days < RELATIVE_DAYS) return `${plural(days, "day", "days")} ago`;
  return formatDate(at, now);
}

/** The same moment in as few characters as a list column has room for. */
export function formatCompactTime(at: number | undefined | null, now: number): string | null {
  if (!usable(at)) return null;
  const elapsed = now - at;
  if (elapsed < -CLOCK_SKEW) return formatDate(at, now);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  const days = calendarDaysBetween(at, now);
  if (days <= 0 || elapsed < 6 * HOUR) return `${Math.floor(elapsed / HOUR)}h`;
  if (days < RELATIVE_DAYS) return `${days}d`;
  return formatDate(at, now);
}

/** A heading for a day's worth of rows. A future day reads as today: it is the clock that is wrong. */
export function formatDayLabel(at: number, now: number): string {
  const days = calendarDaysBetween(at, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear(at, now) ? {} : { year: "numeric" }),
  });
}

/** A fixed record's moment: the day, then the clock. `null` when it was never recorded. */
export function formatTimestamp(at: number | undefined | null, now: number): string | null {
  if (!usable(at)) return null;
  return `${formatDayLabel(at, now)} ${formatClockTime(at)}`;
}

/** A calendar date with its year, for something that lives for months — a token's expiry. */
export function formatFullDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The full, unambiguous moment — for a tooltip or a `<time>` title. */
export function formatFullTimestamp(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
