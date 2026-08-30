import { useEffect, useMemo, useRef } from "react"
import { IntroSoundEngine } from "@/lib/intro-audio"

export type IntroSound = {
  title: () => void
  chaosTick: () => void
  convergeWhoosh: (intensity?: number) => void
  machineHumStart: () => void
  machineHumStop: () => void
  machineClick: () => void
  sortWhoosh: () => void
  sortSnap: () => void
  resolve: () => void
  graphPulse: () => void
  transition: () => void
  dispose: () => void
}

const NOOP_SOUND: IntroSound = {
  title() {},
  chaosTick() {},
  convergeWhoosh() {},
  machineHumStart() {},
  machineHumStop() {},
  machineClick() {},
  sortWhoosh() {},
  sortSnap() {},
  resolve() {},
  graphPulse() {},
  transition() {},
  dispose() {},
}

/**
 * Owns TabDumpIntro's IntroSoundEngine for the component's lifetime. When
 * `enabled` is false (reduced motion, or the intro isn't playing at all)
 * every returned method is a no-op — callers can trigger sound on every
 * scene event unconditionally without branching on whether audio is on.
 *
 * The engine itself is constructed lazily, on the first real trigger call,
 * rather than eagerly in an effect — this keeps a disabled intro (the common
 * case, since it only plays once per browser) from ever touching
 * AudioContext at all.
 */
export function useIntroSound(enabled: boolean): IntroSound {
  const engineRef = useRef<IntroSoundEngine | null>(null)

  useEffect(() => {
    return () => {
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  return useMemo<IntroSound>(() => {
    if (!enabled) return NOOP_SOUND

    const getEngine = (): IntroSoundEngine => {
      if (!engineRef.current) engineRef.current = new IntroSoundEngine()
      return engineRef.current
    }

    return {
      title: () => getEngine().title(),
      chaosTick: () => getEngine().chaosTick(),
      convergeWhoosh: (intensity) => getEngine().convergeWhoosh(intensity),
      machineHumStart: () => getEngine().machineHumStart(),
      machineHumStop: () => getEngine().machineHumStop(),
      machineClick: () => getEngine().machineClick(),
      sortWhoosh: () => getEngine().sortWhoosh(),
      sortSnap: () => getEngine().sortSnap(),
      resolve: () => getEngine().resolve(),
      graphPulse: () => getEngine().graphPulse(),
      transition: () => getEngine().transition(),
      dispose: () => {
        engineRef.current?.dispose()
        engineRef.current = null
      },
    }
  }, [enabled])
}
