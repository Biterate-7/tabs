import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { getOnboardingState, dismissOnboarding, markExtensionConnected } from "./onboarding";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubThrowingLocalStorage(method: "setItem" | "getItem") {
  vi.stubGlobal("localStorage", {
    ...window.localStorage,
    [method]: () => {
      throw new Error("storage unavailable");
    },
  });
}

describe("getOnboardingState", () => {
  it("defaults to not dismissed and not connected", () => {
    expect(getOnboardingState()).toEqual({ dismissed: false, extensionConnected: false });
  });

  it("returns defaults for corrupted JSON instead of throwing", () => {
    window.localStorage.setItem("tabdump:onboarding:v1", "{not json");
    expect(getOnboardingState()).toEqual({ dismissed: false, extensionConnected: false });
  });

  it("returns defaults when storage is unavailable", () => {
    stubThrowingLocalStorage("setItem");
    expect(getOnboardingState()).toEqual({ dismissed: false, extensionConnected: false });
  });
});

describe("dismissOnboarding", () => {
  it("persists dismissed without affecting extensionConnected", () => {
    dismissOnboarding();
    expect(getOnboardingState()).toEqual({ dismissed: true, extensionConnected: false });
  });

  it("does not throw when storage is unavailable", () => {
    stubThrowingLocalStorage("setItem");
    expect(() => dismissOnboarding()).not.toThrow();
  });
});

describe("markExtensionConnected", () => {
  it("persists extensionConnected without affecting dismissed", () => {
    markExtensionConnected();
    expect(getOnboardingState()).toEqual({ dismissed: false, extensionConnected: true });
  });

  it("is additive with a prior dismissOnboarding call", () => {
    dismissOnboarding();
    markExtensionConnected();
    expect(getOnboardingState()).toEqual({ dismissed: true, extensionConnected: true });
  });

  it("does not throw when storage is unavailable", () => {
    stubThrowingLocalStorage("setItem");
    expect(() => markExtensionConnected()).not.toThrow();
  });
});
