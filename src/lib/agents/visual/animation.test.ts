import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_ANIMATIONS,
  animationFor,
  animationStyle,
  resolveAgentMotion,
} from "./animation";
import { AGENT_VISUAL_STATES } from "./types";
import type { AgentVisualIdentity } from "./types";

const IDENTITY: Pick<AgentVisualIdentity, "animations"> = {
  animations: {
    working: { keyframes: "custom-work", durationMs: 1234, iterations: "infinite" },
    // An identity trying to make a settled state loop forever. The engine
    // must refuse: a provider's styling may not contradict the domain.
    success: { keyframes: "custom-forever", durationMs: 900, iterations: "infinite" },
  },
};

describe("resolving how much motion is allowed", () => {
  it("lets full motion through when nothing asks for less", () => {
    expect(resolveAgentMotion({ prefersReducedMotion: false })).toBe("full");
    expect(
      resolveAgentMotion({ prefersReducedMotion: false, appLevel: "normal", worldIntensity: "full" })
    ).toBe("full");
  });

  it("obeys the system preference over everything else", () => {
    expect(
      resolveAgentMotion({
        prefersReducedMotion: true,
        appLevel: "expressive",
        worldIntensity: "full",
      })
    ).toBe("none");
  });

  it("obeys the app-wide off switch", () => {
    expect(
      resolveAgentMotion({ prefersReducedMotion: false, appLevel: "off", worldIntensity: "full" })
    ).toBe("none");
  });

  it("obeys the world's own off switch", () => {
    expect(
      resolveAgentMotion({ prefersReducedMotion: false, appLevel: "normal", worldIntensity: "off" })
    ).toBe("none");
  });

  it("takes the narrower of the app and world levels", () => {
    // The app says "some, not much"; the world asking for full does not
    // widen it.
    expect(
      resolveAgentMotion({
        prefersReducedMotion: false,
        appLevel: "reduced",
        worldIntensity: "full",
      })
    ).toBe("subtle");
    expect(
      resolveAgentMotion({
        prefersReducedMotion: false,
        appLevel: "expressive",
        worldIntensity: "subtle",
      })
    ).toBe("subtle");
  });
});

describe("choosing an animation", () => {
  it("returns nothing at all when motion is off", () => {
    for (const state of AGENT_VISUAL_STATES) {
      expect(animationFor(IDENTITY, state, "none")).toBeNull();
      expect(animationStyle(IDENTITY, state, "none")).toEqual({});
    }
  });

  it("keeps only the states that mean something is happening at subtle", () => {
    expect(animationFor(undefined, "working", "subtle")).not.toBeNull();
    expect(animationFor(undefined, "thinking", "subtle")).not.toBeNull();
    expect(animationFor(undefined, "communicating", "subtle")).not.toBeNull();
    expect(animationFor(undefined, "starting", "subtle")).not.toBeNull();

    // Ambient life is the first thing to go: a resting agent looks the same
    // whether or not it breathes.
    expect(animationFor(undefined, "idle", "subtle")).toBeNull();
    expect(animationFor(undefined, "success", "subtle")).toBeNull();
  });

  it("prefers an identity's own animation over the shared default", () => {
    expect(animationFor(IDENTITY, "working", "full")?.keyframes).toBe("custom-work");
    expect(animationFor(undefined, "working", "full")?.keyframes).toBe(
      DEFAULT_STATE_ANIMATIONS.working?.keyframes
    );
  });

  it("falls back to the shared default for a state an identity did not declare", () => {
    // What makes adding a provider a matter of metadata: an identity that
    // declares one animation still animates correctly in every other state.
    expect(animationFor(IDENTITY, "thinking", "full")?.keyframes).toBe(
      DEFAULT_STATE_ANIMATIONS.thinking?.keyframes
    );
  });

  it("refuses to let an identity loop a settled state forever", () => {
    // A completed run that kept celebrating would be claiming to still be
    // finishing. The identity asked for `infinite` on `success`; it gets
    // nothing.
    expect(animationFor(IDENTITY, "success", "full")).toBeNull();
  });

  it("never loops a state the presentation table says is still", () => {
    for (const state of ["waiting", "queued"] as const) {
      const config = animationFor(undefined, state, "full");
      expect(config === null || config.iterations !== "infinite").toBe(true);
    }
  });

  it("runs the success and error flourishes exactly once", () => {
    expect(DEFAULT_STATE_ANIMATIONS.success?.iterations).toBe(1);
    expect(DEFAULT_STATE_ANIMATIONS.error?.iterations).toBe(1);
  });

  it("keeps every looping animation slow enough to read as alive, not urgent", () => {
    for (const config of Object.values(DEFAULT_STATE_ANIMATIONS)) {
      if (config?.iterations === "infinite") expect(config.durationMs).toBeGreaterThanOrEqual(1500);
    }
  });
});

describe("the style object", () => {
  it("names a keyframe and scales its duration by the shared variable", () => {
    const style = animationStyle(undefined, "working", "full");
    expect(style.animationName).toBe(DEFAULT_STATE_ANIMATIONS.working?.keyframes);
    expect(String(style.animationDuration)).toContain("--agent-anim-scale");
  });

  it("produces an element with no animation at all when there is nothing to run", () => {
    // Not a zero-duration animation — an element with no `animation-name` is
    // one the compositor never considers.
    expect(animationStyle(undefined, "queued", "full")).toEqual({});
  });
});
