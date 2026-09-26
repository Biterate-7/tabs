import { CircleAlert, CircleCheck, CircleDashed, CircleDot, CirclePause, LoaderCircle } from "lucide-react"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import type { AgentVisualState } from "@/lib/agents/visual/types"
import { cn } from "@/lib/utils"

/**
 * HubbleAgentStatus — what an agent is doing, as one 14px glyph.
 *
 * The reference marks a task's state with a quiet line icon at the secondary
 * tier: a turning ring while it works, a ticked circle when it is done.
 * Colour is spent only where a person has to act or should know something
 * went wrong — attention (waiting on you) takes the link colour, a failure
 * takes the destructive one. Everything else stays ink.
 *
 * The ring is the one moving thing, and only while the state is genuinely
 * ongoing; reduced motion stops it (globals.css) and the accessible name
 * carries the state in words either way.
 */
export function AgentStatusGlyph({
  state,
  className,
  label,
}: {
  state: AgentVisualState
  className?: string
  /** Overrides the state's own word for the accessible name. */
  label?: string
}) {
  const name = label ?? AGENT_VISUAL_STATE_PRESENTATION[state].label
  const common = cn("size-3.5 shrink-0", className)

  switch (state) {
    case "working":
    case "thinking":
    case "starting":
    case "communicating":
      return <LoaderCircle role="img" aria-label={name} className={cn(common, "animate-spin text-muted-foreground [animation-duration:1.4s]")} />
    case "waiting":
      return <CircleDot role="img" aria-label={name} className={cn(common, "text-link")} />
    case "success":
      return <CircleCheck role="img" aria-label={name} className={cn(common, "text-muted-foreground")} />
    case "error":
      return <CircleAlert role="img" aria-label={name} className={cn(common, "text-destructive")} />
    case "queued":
      return <CircleDashed role="img" aria-label={name} className={cn(common, "text-tertiary")} />
    case "idle":
    default:
      return <CirclePause role="img" aria-label={name} className={cn(common, "text-tertiary")} />
  }
}
