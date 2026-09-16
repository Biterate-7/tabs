import { describe, expect, it } from "vitest";
import { AGENT_RUN_STATUSES, AGENT_WORK_ITEM_STATUSES } from "@/lib/agents/types";
import { CONNECTOR_STATUS_KINDS } from "@/lib/agents/connectors/types";
import {
  AGENT_VISUAL_STATE_PRESENTATION,
  CONNECTOR_STATUS_VISUALS,
  visualStateForConnector,
  visualStateForRun,
  visualStateForWorkItem,
} from "./states";
import { AGENT_VISUAL_STATES } from "./types";

describe("the visual state vocabulary", () => {
  it("presents every state", () => {
    for (const state of AGENT_VISUAL_STATES) {
      expect(AGENT_VISUAL_STATE_PRESENTATION[state]).toBeDefined();
    }
  });

  it("gives every state a glyph and a word, not only a colour or a motion", () => {
    // The accessibility floor for the whole feature: with animation off and
    // colour unperceived, a state still has to be readable.
    for (const state of AGENT_VISUAL_STATES) {
      const presentation = AGENT_VISUAL_STATE_PRESENTATION[state];
      expect(presentation.glyph.length).toBeGreaterThan(0);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.description.length).toBeGreaterThan(0);
    }
  });

  it("gives every state a distinct glyph", () => {
    const glyphs = AGENT_VISUAL_STATES.map((state) => AGENT_VISUAL_STATE_PRESENTATION[state].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("animates only states that describe something ongoing", () => {
    const animated = AGENT_VISUAL_STATES.filter(
      (state) => AGENT_VISUAL_STATE_PRESENTATION[state].animated
    );
    expect([...animated].sort()).toEqual(
      ["communicating", "starting", "thinking", "working"].sort()
    );
  });

  it("never marks a settled state as live", () => {
    for (const state of ["idle", "queued", "waiting", "success", "error"] as const) {
      expect(AGENT_VISUAL_STATE_PRESENTATION[state].animated).toBe(false);
    }
  });
});

describe("a run's visual state", () => {
  it("covers every domain run status", () => {
    for (const status of AGENT_RUN_STATUSES) {
      const state = visualStateForRun({ status });
      expect(AGENT_VISUAL_STATES).toContain(state);
    }
  });

  it("is working when the run has named what it is doing", () => {
    expect(visualStateForRun({ status: "working", currentActivity: "Editing auth.ts" })).toBe(
      "working"
    );
    expect(visualStateForRun({ status: "working", hasNamedWork: true })).toBe("working");
  });

  it("is thinking when the run is live and has named nothing", () => {
    expect(visualStateForRun({ status: "working" })).toBe("thinking");
    // Whitespace is not a name. The domain collapses and trims its own
    // strings, but a caller passing raw state must not turn " " into a claim
    // that the run reported something.
    expect(visualStateForRun({ status: "working", currentActivity: "   " })).toBe("thinking");
  });

  it("is communicating only while the run is working and handing off", () => {
    expect(
      visualStateForRun({ status: "working", currentActivity: "x", isHandingOff: true })
    ).toBe("communicating");
    // A finished run that once shared a file is finished, not communicating.
    expect(visualStateForRun({ status: "completed", isHandingOff: true })).toBe("success");
  });

  it("treats failed and blocked alike visually, and cancelled differently", () => {
    expect(visualStateForRun({ status: "failed" })).toBe("error");
    expect(visualStateForRun({ status: "blocked" })).toBe("error");
    // Cancelled work was stopped on purpose; drawing it as a problem would
    // invent one.
    expect(visualStateForRun({ status: "cancelled" })).toBe("idle");
  });
});

describe("a work item's visual state", () => {
  it("covers every domain work item status", () => {
    for (const status of AGENT_WORK_ITEM_STATUSES) {
      expect(AGENT_VISUAL_STATES).toContain(visualStateForWorkItem(status));
    }
  });

  it("asks for attention on a blocked item without calling it finished", () => {
    expect(visualStateForWorkItem("blocked")).toBe("error");
    expect(visualStateForWorkItem("completed")).toBe("success");
  });
});

describe("a connector's visual state", () => {
  it("covers every connection state", () => {
    for (const kind of CONNECTOR_STATUS_KINDS) {
      expect(AGENT_VISUAL_STATES).toContain(visualStateForConnector(kind));
    }
  });

  it("does not animate a connector that is merely connected", () => {
    // "Connected and has observed nothing" is idle, exactly as the connector
    // layer's own health derivation reports it. Animating it would be the app
    // implying activity that has not happened.
    expect(visualStateForConnector("connected")).toBe("idle");
    expect(AGENT_VISUAL_STATE_PRESENTATION.idle.animated).toBe(false);
  });

  it("animates only while a connection is being established", () => {
    expect(visualStateForConnector("connecting")).toBe("starting");
    expect(visualStateForConnector("reconnecting")).toBe("starting");
  });

  it("keeps a distinct glyph for every connection state that asks something different", () => {
    // disconnected / configuration_required / unavailable map to one visual
    // state, but must stay tellable apart on screen — collapsing them would
    // send someone hunting for a setting that does not exist.
    expect(CONNECTOR_STATUS_VISUALS.connected.glyph).not.toBe(
      CONNECTOR_STATUS_VISUALS.disconnected.glyph
    );
    expect(CONNECTOR_STATUS_VISUALS.configuration_required.glyph).not.toBe(
      CONNECTOR_STATUS_VISUALS.disconnected.glyph
    );
    expect(CONNECTOR_STATUS_VISUALS.error.tone).toBe("bad");
  });

  it("presents every connection state", () => {
    for (const kind of CONNECTOR_STATUS_KINDS) {
      expect(CONNECTOR_STATUS_VISUALS[kind].glyph.length).toBeGreaterThan(0);
    }
  });
});

