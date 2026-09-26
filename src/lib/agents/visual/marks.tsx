import type { AgentMarkProps } from "./types";

/**
 * The provider marks.
 *
 * ## On branding
 *
 * Every mark in this file is an **original geometric device**, drawn for
 * Hubble. None of them reproduces, approximates or parodies a provider's
 * real logo, wordmark or mascot, and that is a deliberate constraint rather
 * than an artistic choice: a hand-drawn near-copy of someone else's mark is
 * both a trademark problem and a worse design, because it invites the
 * comparison it will always lose. What a mark here has to do is narrower and
 * achievable — be *distinguishable at 16px* and stay stable, so that a person
 * learns "the twin diamonds are Gemini" the same way they learn any other
 * interface convention.
 *
 * If official, licensed assets become available for a provider, swapping one
 * in means changing the `icon` on that provider's entry in `./catalog.ts` and
 * nothing else. No component imports a mark directly.
 *
 * ## The drawing contract
 *
 * Every mark:
 *
 *   - draws inside a 24×24 viewBox, so sizes are interchangeable;
 *   - uses `currentColor`, so the caller's tone or accent decides the colour
 *     and a failing agent can be drawn in the error tone whatever its brand
 *     colour is;
 *   - keeps every stroke at 1.5 units or thicker, which is the width that
 *     survives being rasterised at 14px on a 1× display;
 *   - is decorative unless given a `title`, because the mark almost always
 *     sits beside the name it would otherwise repeat;
 *   - holds no animation and no state. Marks used to carry a
 *     `data-agent-orbit` element that globals.css spun according to the
 *     state on an ancestor; the marks are static now, and adding a provider
 *     stayed a drawing problem rather than becoming a state-machine one.
 */

/** Shared wrapper: sizing, colour inheritance, and the accessible-vs-decorative decision. */
function Mark({
  size,
  title,
  className,
  children,
}: AgentMarkProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      // A mark with a title is content; one without is decoration sitting
      // beside the name that already says this. Both are correct, and which
      // one applies is the caller's to decide.
      {...(title ? { role: "img" } : { "aria-hidden": true, focusable: false })}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/**
 * The fallback.
 *
 * A container with something inside it: the most neutral possible reading of
 * "an agent". Used for a provider this build has no identity for, and drawn
 * so it looks intentional rather than broken — see the note in ./registry.ts.
 */
export function GenericAgentMark(props: AgentMarkProps): React.ReactElement {
  return (
    <Mark {...props}>
      <rect x={4} y={5} width={16} height={14} rx={4} />
      <circle cx={12} cy={12} r={2.4} fill="currentColor" stroke="none" />
    </Mark>
  );
}

/**
 * Claude Code: a caret held inside an open orbit.
 *
 * The caret is the shell prompt this provider is observed through; the
 * broken ring around it is the observation. The gap in the ring is the point
 * — Hubble watches, it does not close the loop and drive anything.
 */
export function ClaudeCodeMark(props: AgentMarkProps): React.ReactElement {
  return (
    <Mark {...props}>
      {/* An arc rather than a circle: deliberately open at the right. */}
      <path d="M17.4 6.2a8 8 0 1 0 2.4 7.3" />
      <path d="M8.6 9.2 11.8 12l-3.2 2.8" />
      <circle cx={19.4} cy={5.6} r={1.9} fill="currentColor" stroke="none" />
    </Mark>
  );
}

/**
 * OpenAI / Codex: a lattice cell.
 *
 * A hexagon with its own centre repeated at half scale — a structure made of
 * the same structure, which is as close as an abstract mark gets to saying
 * "generated".
 */
export function CodexMark(props: AgentMarkProps): React.ReactElement {
  return (
    <Mark {...props}>
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" />
      <path d="M12 8.4 15.8 10.6v4.4L12 17.2 8.2 15V10.6Z" />
    </Mark>
  );
}

/**
 * Gemini: twin diamonds.
 *
 * Two of the same shape, offset and overlapping, for a provider whose name is
 * about a pair. The overlap is drawn rather than implied so the mark still
 * reads as two things at 14px.
 */
export function GeminiMark(props: AgentMarkProps): React.ReactElement {
  return (
    <Mark {...props}>
      <path d="M9 3.6 14.4 12 9 20.4 3.6 12Z" />
      <path d="M15.6 7.2 20.4 12l-4.8 4.8L10.8 12Z" />
    </Mark>
  );
}

/**
 * Grok: a stacked chevron.
 *
 * Two nested angles climbing to the right — direction and pace, with no
 * enclosing shape at all, which is what keeps it from being confused with the
 * two marks above at small sizes.
 */
export function GrokMark(props: AgentMarkProps): React.ReactElement {
  return (
    <Mark {...props}>
      <path d="M4.6 16.4 10.4 9.2l4 4.6 4.8-6" />
      <path d="M4.6 20.4h14.6" strokeWidth={1.5} />
      <circle cx={19.2} cy={7.8} r={1.8} fill="currentColor" stroke="none" />
    </Mark>
  );
}

/**
 * Custom: an open outline.
 *
 * A dashed boundary with a centre mark — a seam waiting to be filled in,
 * which is exactly what the custom connector is. It reads as unfinished on
 * purpose, because a custom agent is something the person integrating it has
 * yet to supply.
 */
export function CustomAgentMark(props: AgentMarkProps): React.ReactElement {
  return (
    <Mark {...props}>
      <circle cx={12} cy={12} r={8.2} strokeDasharray="3 3" />
      <path d="M12 8.6v6.8M8.6 12h6.8" />
    </Mark>
  );
}
