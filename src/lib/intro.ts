import { getSettings } from "@/lib/settings";

/**
 * Whether to play the cinematic chaos-to-structure intro on this landing
 * page load. Purely a reflection of the persisted "Play intro animation"
 * setting (on by default) — there is deliberately no "already seen it once"
 * tracking here, so every fresh load (refresh, new tab, reopening the site)
 * plays the intro again as long as the setting stays on. See lib/settings.ts.
 */
export function shouldPlayIntro(): boolean {
  return getSettings().playIntro;
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
