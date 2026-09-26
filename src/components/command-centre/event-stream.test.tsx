import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { EventStream } from "./event-stream"
import type { SequencedControlEvent } from "@/lib/agents/runtime/protocol"

function event(sequence: number): SequencedControlEvent {
  return {
    id: `e${sequence}`,
    sessionId: "s1",
    provider: "claude-code",
    kind: "message_received",
    summary: "Reply",
    messageId: `m${sequence}`,
    text: `Reply ${sequence}`,
    timestamp: sequence,
    sequence,
  }
}

describe("EventStream following", () => {
  const original = Element.prototype.scrollIntoView
  afterEach(() => {
    Element.prototype.scrollIntoView = original
  })

  it("follows new events without dragging the page along (block: nearest)", () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const { rerender } = render(<EventStream events={[event(1)]} />)
    expect(spy).not.toHaveBeenCalled()
    rerender(<EventStream events={[event(1), event(2)]} />)
    expect(spy).toHaveBeenCalledWith({ block: "nearest" })
  })

  it("does not move when a poll returns the same events", () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const events = [event(1)]
    const { rerender } = render(<EventStream events={events} />)
    rerender(<EventStream events={[...events]} />)
    expect(spy).not.toHaveBeenCalled()
  })
})
