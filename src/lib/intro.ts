const STORAGE_KEY = "tabdump:intro-seen:v1";

function storageAvailable(): boolean {
  try {
    const testKey = "__tabdump_intro_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * The cinematic intro is a first-visit signature moment, not something a
 * returning user should sit through repeatedly — LandingView also doubles as
 * the empty-workspace state (see app-shell.tsx), which a user can land on
 * often (e.g. after clearing a workspace). Storage being unavailable is
 * treated as "already seen": replaying an ~8s animation every reload would
 * be far more annoying than never showing it once.
 */
export function shouldPlayIntro(): boolean {
  if (!storageAvailable()) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "1";
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Non-critical — worst case the intro plays again next visit.
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  // A viewport width of 0 means the layout engine hasn't established real
  // dimensions yet (observed in at least one embedded-preview host) rather
  // than an actually-0px window — treat that as "unknown" and default to
  // the fuller desktop experience instead of silently downgrading it.
  return window.innerWidth > 0 && window.innerWidth < 640;
}
