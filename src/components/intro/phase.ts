export type IntroPhase =
  | "title"
  | "chaos"
  | "converge"
  | "machine"
  | "organized"
  | "graph"
  | "exit"
  | "done"

type ScheduleEntry = { phase: IntroPhase; at: number }

/** ~8.5s full desktop/mobile timeline — see AGENTS.md's "0.0s → 9.0s" sequence. Mobile reuses the same beats; only element count/spread shrinks (see intro-data.ts), not pacing. */
export const FULL_SCHEDULE: ScheduleEntry[] = [
  { phase: "chaos", at: 550 },
  { phase: "converge", at: 2500 },
  { phase: "machine", at: 3400 },
  { phase: "organized", at: 5000 },
  { phase: "graph", at: 6600 },
  { phase: "exit", at: 7900 },
  { phase: "done", at: 8550 },
]

/** prefers-reduced-motion: no scattering/converging/scanning — just the title, then the payoff state, then the real page. Movement is what's cut; the "chaos → structure" story is preserved as a couple of opacity swaps. */
export const REDUCED_SCHEDULE: ScheduleEntry[] = [
  { phase: "organized", at: 300 },
  { phase: "exit", at: 900 },
  { phase: "done", at: 1250 },
]

export const EXIT_DURATION_MS = 650
export const SKIP_EXIT_DURATION_MS = 200
