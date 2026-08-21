import { isStorageAvailable } from "@/lib/workspace/persistence";

const STORAGE_KEY = "tabdump:onboarding:v1";

type OnboardingState = {
  /** User explicitly chose "Paste URLs manually" instead of installing. */
  dismissed: boolean;
  /**
   * The extension has successfully delivered at least one import — the
   * only honest signal we have that it's actually installed, since there's
   * no secure way to detect a Chrome extension's presence from a webpage.
   * Recorded in use-extension-import.ts at the moment a real import lands.
   */
  extensionConnected: boolean;
};

const DEFAULT_STATE: OnboardingState = { dismissed: false, extensionConnected: false };

function readState(): OnboardingState {
  if (!isStorageAvailable()) return DEFAULT_STATE;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_STATE;

    return {
      dismissed: Boolean(parsed.dismissed),
      extensionConnected: Boolean(parsed.extensionConnected),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeState(patch: Partial<OnboardingState>): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readState(), ...patch }));
  } catch {
    // Storage unavailable mid-session: onboarding just isn't persisted this time.
  }
}

export function getOnboardingState(): OnboardingState {
  return readState();
}

export function dismissOnboarding(): void {
  writeState({ dismissed: true });
}

export function markExtensionConnected(): void {
  writeState({ extensionConnected: true });
}
