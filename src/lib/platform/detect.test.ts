import { describe, it, expect, afterEach } from "vitest";
import { isDesktop, platformKind } from "./detect";

function setTauriGlobal(present: boolean) {
  if (present) {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: () => {} };
  } else {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  }
}

describe("isDesktop", () => {
  afterEach(() => setTauriGlobal(false));

  it("is false in a plain browser, which is what keeps the web app on its existing paths", () => {
    setTauriGlobal(false);
    expect(isDesktop()).toBe(false);
    expect(platformKind()).toBe("web");
  });

  it("is true once the Tauri runtime has injected its internals global", () => {
    setTauriGlobal(true);
    expect(isDesktop()).toBe(true);
    expect(platformKind()).toBe("desktop");
  });

  it("keys off __TAURI_INTERNALS__, not __TAURI__, which withGlobalTauri:false never defines", () => {
    setTauriGlobal(false);
    (window as unknown as Record<string, unknown>).__TAURI__ = { mock: true };
    expect(isDesktop()).toBe(false);
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });
});
