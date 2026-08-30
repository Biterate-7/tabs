import { createContext, useContext, cloneElement, type ReactElement } from "react"

const IntroRevealContext = createContext(false)

/**
 * Marks whether LandingView's hero should play its staggered reveal right
 * now. Only ever true for the moment TabDumpIntro's real first-visit intro
 * hands off into the landing page — a repeat visit (intro skipped entirely,
 * `shouldPlayIntro()` false) never sets this, so the hero just renders
 * normally with no animation.
 */
export function IntroRevealProvider({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <IntroRevealContext.Provider value={active}>{children}</IntroRevealContext.Provider>
}

const STAGGER_MS = 90
const REVEAL_DURATION_MS = 420

/**
 * Gives its single child a brief stagger-in entrance ("hero title -> subtitle
 * -> CTA -> secondary content", per `order`) at the moment the intro's exit
 * crossfade begins. Outside an active reveal this is a pure passthrough —
 * no wrapper DOM node, no style, no cost — so wrapping LandingView's markup
 * in this is free on every visit that never plays the intro.
 */
export function IntroReveal({ order, children }: { order: number; children: ReactElement }) {
  const active = useContext(IntroRevealContext)
  if (!active) return children
  const props = children.props as { style?: React.CSSProperties }
  return cloneElement(children as ReactElement<{ style?: React.CSSProperties }>, {
    style: {
      ...props.style,
      animation: `hero-reveal ${REVEAL_DURATION_MS}ms var(--ease-standard) ${order * STAGGER_MS}ms both`,
    },
  })
}
