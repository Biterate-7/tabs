"use client"

import { useEffect, useSyncExternalStore } from "react"
import { peekFaviconSrc, requestFavicon, subscribeFavicons } from "@/lib/favicon/client"

/**
 * The favicon URL to render for `domain`, or null to render the fallback.
 * Null on the server and during hydration, so markup always matches; the
 * lookup itself starts from an effect, never during render.
 */
export function useFaviconSrc(domain: string): string | null {
  const src = useSyncExternalStore(subscribeFavicons, () => peekFaviconSrc(domain), () => null)
  useEffect(() => {
    requestFavicon(domain)
  }, [domain])
  return src
}
