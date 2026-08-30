import { isStorageAvailable } from "@/lib/workspace/persistence";

const STORAGE_KEY = "tabdump:settings:v1";

export type Settings = {
  /**
   * Show the cinematic chaos-to-structure intro on every landing page load.
   * Defaults to on. Deliberately independent of any "has the user seen this
   * before" tracking — the intro replaying on every load is the point, and
   * this setting is the only thing allowed to turn that off.
   */
  playIntro: boolean;
};

const DEFAULT_SETTINGS: Settings = { playIntro: true };

function readSettings(): Settings {
  if (!isStorageAvailable()) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return {
      playIntro: typeof parsed.playIntro === "boolean" ? parsed.playIntro : DEFAULT_SETTINGS.playIntro,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(patch: Partial<Settings>): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readSettings(), ...patch }));
  } catch {
    // Non-critical UI preference — worst case it doesn't persist this time.
  }
}

export function getSettings(): Settings {
  return readSettings();
}

export function setPlayIntro(enabled: boolean): void {
  writeSettings({ playIntro: enabled });
}
