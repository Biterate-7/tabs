/**
 * Tiny procedural sound engine for TabDumpIntro — precision-software UI
 * tones (short sine blips, filtered-noise whooshes/clicks), synthesized with
 * Web Audio rather than shipped as audio assets. Every public method is a
 * fire-and-forget trigger: it either plays immediately or silently does
 * nothing (no AudioContext available, construction/playback threw, or the
 * engine has been disposed) — callers never need to check availability
 * themselves.
 *
 * One AudioContext is created lazily on first use and reused for the whole
 * intro; `dispose()` tears it down. Every node this engine creates is
 * disconnected once it finishes playing (via `onended`), so nothing
 * accumulates over the intro's lifetime.
 */

type AudioContextCtor = typeof AudioContext

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null
  const withWebkit = window as unknown as { webkitAudioContext?: AudioContextCtor }
  return window.AudioContext ?? withWebkit.webkitAudioContext ?? null
}

export class IntroSoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private humOsc: OscillatorNode | null = null
  private humGain: GainNode | null = null
  private unlockAttached = false
  private closed = false

  private getContext(): AudioContext | null {
    if (this.closed) return null
    if (this.ctx) return this.ctx
    const Ctor = resolveAudioContextCtor()
    if (!Ctor) return null
    try {
      const ctx = new Ctor()
      const master = ctx.createGain()
      master.gain.value = 0.14
      master.connect(ctx.destination)
      this.ctx = ctx
      this.master = master
      // Browsers commonly start a freshly-created AudioContext suspended
      // until a user gesture. The intro must never wait on or require one —
      // it just quietly resumes if/when a gesture happens to occur.
      if (ctx.state === "suspended") this.attachUnlock(ctx)
      return ctx
    } catch {
      return null
    }
  }

  private attachUnlock(ctx: AudioContext) {
    if (this.unlockAttached || typeof window === "undefined") return
    this.unlockAttached = true
    const resume = () => {
      ctx.resume().catch(() => {})
    }
    const opts: AddEventListenerOptions = { once: true, passive: true }
    window.addEventListener("pointerdown", resume, opts)
    window.addEventListener("keydown", resume, opts)
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.5)), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuffer = buffer
    return buffer
  }

  private scheduledTone(t0: number, freq: number, gain: number, duration: number, release: number) {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = "sine"
    osc.frequency.value = freq
    env.gain.setValueAtTime(0, t0)
    env.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.008, duration))
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + release)
    osc.connect(env)
    env.connect(this.master)
    osc.start(t0)
    osc.stop(t0 + duration + release + 0.02)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
    }
  }

  private tone(freq: number, gain: number, duration: number, release: number) {
    const ctx = this.getContext()
    if (!ctx) return
    try {
      this.scheduledTone(ctx.currentTime, freq, gain, duration, release)
    } catch {
      // Best-effort — a synth glitch should never surface to the caller.
    }
  }

  private click(gain: number, duration: number, filterFreq: number) {
    const ctx = this.getContext()
    if (!ctx || !this.master) return
    try {
      const src = ctx.createBufferSource()
      src.buffer = this.getNoiseBuffer(ctx)
      const filter = ctx.createBiquadFilter()
      filter.type = "highpass"
      filter.frequency.value = filterFreq
      const env = ctx.createGain()
      const t0 = ctx.currentTime
      env.gain.setValueAtTime(gain, t0)
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
      src.connect(filter)
      filter.connect(env)
      env.connect(this.master)
      src.start(t0)
      src.stop(t0 + duration + 0.02)
      src.onended = () => {
        src.disconnect()
        filter.disconnect()
        env.disconnect()
      }
    } catch {
      // ignore
    }
  }

  private whoosh(gain: number, duration: number, freqFrom: number, freqTo: number) {
    const ctx = this.getContext()
    if (!ctx || !this.master) return
    try {
      const src = ctx.createBufferSource()
      src.buffer = this.getNoiseBuffer(ctx)
      src.loop = true
      const filter = ctx.createBiquadFilter()
      filter.type = "bandpass"
      filter.Q.value = 0.9
      const t0 = ctx.currentTime
      filter.frequency.setValueAtTime(freqFrom, t0)
      filter.frequency.linearRampToValueAtTime(freqTo, t0 + duration)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0, t0)
      env.gain.linearRampToValueAtTime(gain, t0 + duration * 0.35)
      env.gain.linearRampToValueAtTime(0.0001, t0 + duration)
      src.connect(filter)
      filter.connect(env)
      env.connect(this.master)
      src.start(t0)
      src.stop(t0 + duration + 0.02)
      src.onended = () => {
        src.disconnect()
        filter.disconnect()
        env.disconnect()
      }
    } catch {
      // ignore
    }
  }

  /** TITLE — an almost-imperceptible tick as the wordmark appears. */
  title() {
    this.tone(860, 0.11, 0.045, 0.09)
  }

  /** CHAOS — one tiny tick for a scattering tab. Callers sample a sparse subset; this never fires per-tab. */
  chaosTick() {
    this.click(0.13, 0.014, 4200)
  }

  /** CONVERGENCE — soft whoosh as tabs funnel toward center. `intensity` nudges gain up as more tabs join. */
  convergeWhoosh(intensity = 1) {
    this.whoosh(0.12 + intensity * 0.05, 0.6, 260, 1200)
  }

  /** PROCESSING MACHINE — a very quiet sustained hum for as long as the machine is active. */
  machineHumStart() {
    const ctx = this.getContext()
    if (!ctx || !this.master || this.humOsc) return
    try {
      const osc = ctx.createOscillator()
      const filter = ctx.createBiquadFilter()
      const env = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = 92
      filter.type = "lowpass"
      filter.frequency.value = 220
      const t0 = ctx.currentTime
      env.gain.setValueAtTime(0, t0)
      env.gain.linearRampToValueAtTime(0.045, t0 + 0.35)
      osc.connect(filter)
      filter.connect(env)
      env.connect(this.master)
      osc.start(t0)
      this.humOsc = osc
      this.humGain = env
    } catch {
      // ignore
    }
  }

  machineHumStop() {
    const ctx = this.ctx
    const osc = this.humOsc
    const env = this.humGain
    this.humOsc = null
    this.humGain = null
    if (!ctx || !osc || !env) return
    try {
      const t0 = ctx.currentTime
      env.gain.cancelScheduledValues(t0)
      env.gain.setValueAtTime(env.gain.value, t0)
      env.gain.linearRampToValueAtTime(0.0001, t0 + 0.22)
      osc.stop(t0 + 0.28)
      osc.onended = () => {
        osc.disconnect()
        env.disconnect()
      }
    } catch {
      // ignore
    }
  }

  /** PROCESSING MACHINE — occasional click as a group of tabs passes through. */
  machineClick() {
    this.click(0.1, 0.016, 2600)
  }

  /** SORTING — short directional whoosh as groups separate into their collections. */
  sortWhoosh() {
    this.whoosh(0.15, 0.4, 900, 320)
  }

  /** SORTING — subtle snap as one group settles into place. */
  sortSnap() {
    this.click(0.2, 0.022, 1800)
  }

  /** FINAL ORGANIZATION — one satisfying two-note resolve, more pronounced than everything else but still restrained. */
  resolve() {
    const ctx = this.getContext()
    if (!ctx || !this.master) return
    try {
      const t0 = ctx.currentTime
      this.scheduledTone(t0, 523.25, 0.22, 0.11, 0.17)
      this.scheduledTone(t0 + 0.1, 783.99, 0.2, 0.13, 0.22)
    } catch {
      // ignore
    }
  }

  /** GRAPH EMERGENCE — very subtle tonal pulse. Callers sample a small subset of edges/nodes, never all of them. */
  graphPulse() {
    this.tone(1180, 0.08, 0.03, 0.06)
  }

  /** TRANSITION — a soft, low swell timed with the full-page handoff into the landing page. */
  transition() {
    this.whoosh(0.07, 0.7, 220, 640)
  }

  /** Stops the hum, releases every audio node, and closes the AudioContext. Safe to call more than once. */
  dispose() {
    if (this.closed) return
    this.machineHumStop()
    this.closed = true
    const ctx = this.ctx
    this.ctx = null
    this.master = null
    this.noiseBuffer = null
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => {})
    }
  }
}
