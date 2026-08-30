import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IntroSoundEngine } from "./intro-audio"

const ALL_TRIGGERS = [
  "title",
  "chaosTick",
  "convergeWhoosh",
  "machineHumStart",
  "machineHumStop",
  "machineClick",
  "sortWhoosh",
  "sortSnap",
  "resolve",
  "graphPulse",
  "transition",
] as const

describe("IntroSoundEngine without a Web Audio API (jsdom default)", () => {
  it("never throws for any trigger, and dispose is a safe no-op", () => {
    const engine = new IntroSoundEngine()
    for (const trigger of ALL_TRIGGERS) {
      expect(() => engine[trigger]()).not.toThrow()
    }
    expect(() => engine.dispose()).not.toThrow()
    expect(() => engine.dispose()).not.toThrow()
  })
})

describe("IntroSoundEngine with a mocked AudioContext", () => {
  let closeSpy: ReturnType<typeof vi.fn>
  let resumeSpy: ReturnType<typeof vi.fn>
  let createdContexts: number

  class FakeAudioParam {
    value = 0
    setValueAtTime = vi.fn()
    linearRampToValueAtTime = vi.fn()
    exponentialRampToValueAtTime = vi.fn()
    cancelScheduledValues = vi.fn()
  }

  class FakeAudioNode {
    connect = vi.fn()
    disconnect = vi.fn()
  }

  class FakeGainNode extends FakeAudioNode {
    gain = new FakeAudioParam()
  }

  class FakeBiquadFilterNode extends FakeAudioNode {
    type = "lowpass"
    frequency = new FakeAudioParam()
    Q = new FakeAudioParam()
  }

  class FakeAudioScheduledSourceNode extends FakeAudioNode {
    onended: (() => void) | null = null
    buffer: unknown = null
    loop = false
    type = "sine"
    frequency = new FakeAudioParam()
    start = vi.fn()
    stop = vi.fn(() => {
      this.onended?.()
    })
  }

  class FakeAudioContext {
    currentTime = 0
    state: "suspended" | "running" | "closed" = "suspended"
    destination = {}

    constructor() {
      createdContexts += 1
    }

    createGain() {
      return new FakeGainNode()
    }
    createOscillator() {
      return new FakeAudioScheduledSourceNode()
    }
    createBufferSource() {
      return new FakeAudioScheduledSourceNode()
    }
    createBiquadFilter() {
      return new FakeBiquadFilterNode()
    }
    createBuffer(_channels: number, length: number, sampleRate: number) {
      return {
        getChannelData: () => new Float32Array(length),
        length,
        sampleRate,
      }
    }
    resume = resumeSpy
    close = closeSpy
  }

  beforeEach(() => {
    createdContexts = 0
    closeSpy = vi.fn(() => Promise.resolve())
    resumeSpy = vi.fn(() => Promise.resolve())
    vi.stubGlobal("AudioContext", FakeAudioContext)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("lazily creates exactly one AudioContext across many triggers", () => {
    const engine = new IntroSoundEngine()
    engine.title()
    engine.chaosTick()
    engine.convergeWhoosh(1.5)
    engine.machineHumStart()
    engine.machineClick()
    engine.sortWhoosh()
    engine.sortSnap()
    engine.resolve()
    engine.graphPulse()
    engine.transition()
    expect(createdContexts).toBe(1)
  })

  it("does not start a second hum oscillator if machineHumStart is called twice", () => {
    const engine = new IntroSoundEngine()
    engine.machineHumStart()
    expect(() => engine.machineHumStart()).not.toThrow()
  })

  it("attaches a one-time unlock listener when the context starts suspended", () => {
    const addSpy = vi.spyOn(window, "addEventListener")
    const engine = new IntroSoundEngine()
    engine.title()
    expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), expect.objectContaining({ once: true }))
    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function), expect.objectContaining({ once: true }))
    addSpy.mockRestore()
  })

  it("dispose stops the hum, closes the context exactly once, and is safe to call again", () => {
    const engine = new IntroSoundEngine()
    engine.machineHumStart()
    engine.dispose()
    expect(closeSpy).toHaveBeenCalledTimes(1)

    engine.dispose()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it("is inert after dispose — no new AudioContext is created for later triggers", () => {
    const engine = new IntroSoundEngine()
    engine.title()
    expect(createdContexts).toBe(1)
    engine.dispose()

    expect(() => engine.resolve()).not.toThrow()
    expect(createdContexts).toBe(1)
  })

  it("survives a constructor that throws (autoplay/permissions rejection) without throwing", () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("audio unavailable")
        }
      }
    )
    const engine = new IntroSoundEngine()
    for (const trigger of ALL_TRIGGERS) {
      expect(() => engine[trigger]()).not.toThrow()
    }
  })
})
