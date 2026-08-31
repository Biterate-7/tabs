/**
 * Tiny procedural sound engine for general interface sound effects (today:
 * the folder zipper-open sound). Mirrors IntroSoundEngine's approach —
 * synthesized with Web Audio rather than shipped as audio assets, so there's
 * nothing to fetch and nothing that can 404. Every public method is a
 * fire-and-forget trigger that either plays immediately or silently does
 * nothing (no AudioContext available, construction/playback threw) —
 * callers never need to check availability themselves.
 *
 * One AudioContext is created lazily on first use; `dispose()` tears it
 * down. Every node this engine creates is disconnected once it finishes
 * playing (via `onended`), so nothing accumulates over the app's lifetime.
 */

type AudioContextCtor = typeof AudioContext

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null
  const withWebkit = window as unknown as { webkitAudioContext?: AudioContextCtor }
  return window.AudioContext ?? withWebkit.webkitAudioContext ?? null
}

export class UiSoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
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
      master.gain.value = 0.16
      master.connect(ctx.destination)
      this.ctx = ctx
      this.master = master
      // A freshly-created AudioContext commonly starts suspended until a
      // user gesture. Every caller of this engine is itself a click
      // handler, so in practice this resolves before we ever try to play —
      // this is just a safety net, never something callers wait on.
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
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.3)), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuffer = buffer
    return buffer
  }

  /**
   * ZIPPER — a short, bright bandpass-filtered noise sweep (the "zzzip")
   * ending in one tiny click (the pull reaching the end of its travel).
   * `volume` is the 0-1 fraction from Settings → General → Sound volume.
   */
  zipperOpen(volume: number) {
    const ctx = this.getContext()
    if (!ctx || !this.master) return
    const gain = Math.max(0, Math.min(1, volume))
    if (gain <= 0) return
    try {
      const t0 = ctx.currentTime
      const duration = 0.16

      const src = ctx.createBufferSource()
      src.buffer = this.getNoiseBuffer(ctx)
      const filter = ctx.createBiquadFilter()
      filter.type = "bandpass"
      filter.Q.value = 5
      filter.frequency.setValueAtTime(1800, t0)
      filter.frequency.exponentialRampToValueAtTime(3400, t0 + duration)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0, t0)
      env.gain.linearRampToValueAtTime(0.22 * gain, t0 + 0.02)
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

      // The pull reaching the end of the zipper — a tiny high click.
      const click = ctx.createBufferSource()
      click.buffer = this.getNoiseBuffer(ctx)
      const clickFilter = ctx.createBiquadFilter()
      clickFilter.type = "highpass"
      clickFilter.frequency.value = 5200
      const clickEnv = ctx.createGain()
      const clickT0 = t0 + duration * 0.85
      clickEnv.gain.setValueAtTime(0.16 * gain, clickT0)
      clickEnv.gain.exponentialRampToValueAtTime(0.0001, clickT0 + 0.03)
      click.connect(clickFilter)
      clickFilter.connect(clickEnv)
      clickEnv.connect(this.master)
      click.start(clickT0)
      click.stop(clickT0 + 0.05)
      click.onended = () => {
        click.disconnect()
        clickFilter.disconnect()
        clickEnv.disconnect()
      }
    } catch {
      // Best-effort — a synth glitch should never surface to the caller.
    }
  }

  /** Releases every audio node and closes the AudioContext. Safe to call more than once. */
  dispose() {
    if (this.closed) return
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
