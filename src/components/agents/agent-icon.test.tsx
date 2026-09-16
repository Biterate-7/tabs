import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AGENT_VISUAL_STATES } from "@/lib/agents/visual/types";
import { AgentIcon } from "./agent-icon";
import { AgentActivityList, AgentLoadingState } from "./agent-activity-list";
import { AgentAvatar, AgentIdentity, AgentStatus } from "./agent-identity";
import { AgentCharacter } from "./agent-character";
import { markColor } from "./agent-tone";
import type { AgentActivityItem } from "./agent-activity-list";

/**
 * The presence primitives, from the outside.
 *
 * These render without an AppearanceProvider on purpose — every one of them
 * has to work as a progressive enhancement, because they appear on surfaces
 * (the canvas sidebar, the settings page) that a test or a future host may
 * mount without the theming context.
 */

function markOf(container: HTMLElement): SVGElement | null {
  return container.querySelector(".agent-mark svg");
}

function wrapperOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".agent-mark");
}

describe("AgentIcon", () => {
  it("draws a different mark for each provider", () => {
    const first = render(<AgentIcon connector="claude-code" />);
    const second = render(<AgentIcon connector="gemini" />);

    expect(markOf(first.container)?.innerHTML).not.toBe(markOf(second.container)?.innerHTML);
  });

  it("draws the same mark for the same provider, whatever its state", () => {
    // A mark that changed shape per state would put the state machine inside
    // five separate drawings instead of in one place.
    const idle = render(<AgentIcon connector="claude-code" state="idle" />);
    const working = render(<AgentIcon connector="claude-code" state="working" />);

    expect(markOf(idle.container)?.innerHTML).toBe(markOf(working.container)?.innerHTML);
  });

  it("falls back for an unknown provider instead of failing to render", () => {
    // §31: a connector with no visual identity degrades to a static icon, and
    // the surrounding agent functionality is unaffected.
    const { container } = render(<AgentIcon connector="an-agent-from-2027" />);
    expect(markOf(container)).not.toBeNull();
  });

  it("renders every state without throwing", () => {
    for (const state of AGENT_VISUAL_STATES) {
      const { container, unmount } = render(<AgentIcon connector="claude-code" state={state} />);
      expect(markOf(container)).not.toBeNull();
      unmount();
    }
  });

  it("carries its state on an attribute, for the stylesheet to select on", () => {
    const { container } = render(<AgentIcon connector="claude-code" state="working" />);
    expect(wrapperOf(container)?.getAttribute("data-agent-state")).toBe("working");
    expect(wrapperOf(container)?.getAttribute("data-agent-provider")).toBe("claude-code");
  });

  it("grows with its size", () => {
    const small = render(<AgentIcon connector="claude-code" size="xs" />);
    const large = render(<AgentIcon connector="claude-code" size="lg" />);

    expect(Number(markOf(large.container)?.getAttribute("width"))).toBeGreaterThan(
      Number(markOf(small.container)?.getAttribute("width"))
    );
  });

  it("is hidden from assistive technology unless it is given a label", () => {
    const { container, unmount } = render(<AgentIcon connector="claude-code" />);
    expect(wrapperOf(container)?.getAttribute("aria-hidden")).toBe("true");
    unmount();

    render(<AgentIcon connector="claude-code" label="Claude Code" />);
    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
  });

  it("does not animate when the world's intensity is off", () => {
    const { container } = render(
      <AgentIcon connector="claude-code" state="working" intensity="off" />
    );
    expect(wrapperOf(container)?.style.animationName).toBe("");
  });

  it("animates a working agent when motion is allowed", () => {
    const { container } = render(<AgentIcon connector="claude-code" state="working" />);
    expect(wrapperOf(container)?.style.animationName.length).toBeGreaterThan(0);
  });

  it("does not animate a finished agent, even at full intensity", () => {
    const { container } = render(
      <AgentIcon connector="claude-code" state="waiting" intensity="full" />
    );
    expect(wrapperOf(container)?.style.animationName).toBe("");
  });
});

describe("colour", () => {
  it("keeps the identity's accent for live and resting states", () => {
    expect(markColor("#abcdef", "live")).toBe("#abcdef");
    expect(markColor("#abcdef", "muted")).toBe("#abcdef");
  });

  it("overrides branding for the two states that are judgements", () => {
    // A brand colour must not be able to make a failed run look fine.
    expect(markColor("#abcdef", "bad")).toBe("var(--destructive)");
    expect(markColor("#abcdef", "good")).toBe("var(--success)");
  });
});

describe("AgentIdentity", () => {
  it("names the agent beside its mark", () => {
    render(<AgentIdentity connector="claude-code" />);
    expect(screen.getByText("Claude Code")).toBeTruthy();
  });

  it("prefers a name the domain recorded over the catalogue's", () => {
    // A run persisted by a build that knew a provider this one does not still
    // has a name the user recognises.
    render(<AgentIdentity connector="unknown-provider" name="Historic Agent" />);
    expect(screen.getByText("Historic Agent")).toBeTruthy();
  });

  it("puts the name on the mark when the name itself is hidden", () => {
    render(<AgentIdentity connector="claude-code" iconOnly />);
    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
  });
});

describe("AgentStatus", () => {
  it("says the state in words, not only as a colour or a motion", () => {
    render(<AgentStatus state="working" />);
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("adds detail without losing the state word", () => {
    render(<AgentStatus state="working" detail="Researching auth" />);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText(/Researching auth/)).toBeTruthy();
  });

  it("renders every state as a readable word", () => {
    for (const state of AGENT_VISUAL_STATES) {
      const { container, unmount } = render(<AgentStatus state={state} />);
      expect(container.textContent?.trim().length).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe("AgentAvatar", () => {
  it("labels itself when it stands alone", () => {
    render(<AgentAvatar connector="gemini" label="Gemini" />);
    expect(screen.getByRole("img", { name: "Gemini" })).toBeTruthy();
  });
});

describe("AgentActivityList", () => {
  const items: AgentActivityItem[] = [
    {
      id: "run:1",
      provider: "claude-code",
      agentName: "Claude Code",
      state: "working",
      activity: "Researching competitor architecture",
      progress: { completed: 3, total: 7 },
    },
    { id: "run:2", provider: "gemini", agentName: "Gemini", state: "waiting" },
  ];

  it("renders nothing when nothing is running", () => {
    const { container } = render(<AgentActivityList items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("names every agent and what it is doing", () => {
    render(<AgentActivityList items={items} />);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText(/Researching competitor architecture/)).toBeTruthy();
    expect(screen.getByText("Gemini")).toBeTruthy();
  });

  it("shows progress only where a real count exists", () => {
    render(<AgentActivityList items={items} />);
    expect(screen.getByText("3/7")).toBeTruthy();
    expect(screen.queryByText("0/0")).toBeNull();
  });

  it("carries state and task in a row's accessible name", () => {
    render(<AgentActivityList items={items} onSelect={() => {}} />);
    expect(
      screen.getByRole("button", {
        name: "Claude Code — Working — Researching competitor architecture",
      })
    ).toBeTruthy();
  });

  it("is a plain list, not a set of buttons, when nothing can be selected", () => {
    render(<AgentActivityList items={items} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("AgentLoadingState", () => {
  it("says who is loading rather than just that something is", () => {
    render(<AgentLoadingState connector="claude-code" name="Claude Code" />);
    expect(screen.getByText("Claude Code is getting ready…")).toBeTruthy();
  });
});

describe("AgentCharacter", () => {
  it("draws a figure in every style", () => {
    for (const style of ["character", "pixel", "illustrated", "futuristic"] as const) {
      const { container, unmount } = render(
        <AgentCharacter connector="claude-code" state="working" style={style} />
      );
      expect(container.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });

  it("draws the mark alone in the minimal style", () => {
    // Someone who chose "icons" wants the arrangement without the
    // anthropomorphism; drawing a small body anyway would ignore the setting.
    const { container } = render(
      <AgentCharacter connector="claude-code" state="working" style="minimal" />
    );
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("gives each style a visibly different drawing", () => {
    const character = render(<AgentCharacter connector="claude-code" state="idle" style="character" />);
    const pixel = render(<AgentCharacter connector="claude-code" state="idle" style="pixel" />);
    expect(character.container.innerHTML).not.toBe(pixel.container.innerHTML);
  });

  it("only picks up its tool while it is working", () => {
    const idle = render(<AgentCharacter connector="claude-code" state="idle" />);
    const working = render(<AgentCharacter connector="claude-code" state="working" />);

    expect(idle.container.querySelectorAll("[data-agent-orbit]")).toHaveLength(0);
    expect(working.container.querySelectorAll("[data-agent-orbit]").length).toBeGreaterThan(0);
  });

  it("is decorative — the button around it carries the name", () => {
    const { container } = render(<AgentCharacter connector="claude-code" state="idle" />);
    expect(container.querySelector(".agent-mark")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("holds still when asked not to animate", () => {
    const { container } = render(
      <AgentCharacter connector="claude-code" state="working" animate={false} />
    );
    expect((container.querySelector(".agent-mark") as HTMLElement).style.animationName).toBe("");
  });
});
