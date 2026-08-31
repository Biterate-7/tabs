import { useEffect, useMemo, useRef } from "react"
import { UiSoundEngine } from "@/lib/ui-sound"

export type UiSound = {
  zipperOpen: (volume: number) => void
  dispose: () => void
}

const NOOP_SOUND: UiSound = {
  zipperOpen() {},
  dispose() {},
}

/**
 * Owns one UiSoundEngine for the component's lifetime. When `enabled` is
 * false (Settings → General → Interface sounds is off) every returned
 * method is a no-op — callers can trigger a sound on interaction
 * unconditionally without branching on whether audio is on.
 *
 * The engine is constructed lazily, on the first real trigger call, rather
 * than eagerly in an effect — most homepage visits never click a folder, so
 * this keeps AudioContext untouched until it's actually needed.
 */
export function useUiSound(enabled: boolean): UiSound {
  const engineRef = useRef<UiSoundEngine | null>(null)

  useEffect(() => {
    return () => {
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  return useMemo<UiSound>(() => {
    if (!enabled) return NOOP_SOUND

    const getEngine = (): UiSoundEngine => {
      if (!engineRef.current) engineRef.current = new UiSoundEngine()
      return engineRef.current
    }

    return {
      zipperOpen: (volume) => getEngine().zipperOpen(volume),
      dispose: () => {
        engineRef.current?.dispose()
        engineRef.current = null
      },
    }
  }, [enabled])
}
