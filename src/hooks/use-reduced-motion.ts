"use client"

import { useSyncExternalStore } from "react"

/**
 * Whether motion should be kept to a minimum: the OS asks for reduced motion,
 * or Settings → Appearance → Motion is off (`data-motion="off"` on the root,
 * written by use-appearance). CSS already honours both for transitions; this
 * is for motion driven from script — the graph's camera and its signal.
 */
function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia?.("(prefers-reduced-motion: reduce)")
  query?.addEventListener?.("change", onChange)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] })
  return () => {
    query?.removeEventListener?.("change", onChange)
    observer.disconnect()
  }
}

function snapshot(): boolean {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) || document.documentElement.dataset.motion === "off"
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
