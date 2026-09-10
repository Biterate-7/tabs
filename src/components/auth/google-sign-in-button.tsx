"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useOptionalAppearanceContext } from "@/components/appearance-provider"
import { requestLoginNonce } from "@/lib/auth/client"
import { loadGsi, type GsiCredentialResponse } from "@/lib/auth/gsi"
import { publicGoogleClientId } from "@/lib/auth/public-config"
import { isDarkColor } from "@/lib/appearance/contrast"

/**
 * Google's own "Continue with Google" button, rendered by Google Identity
 * Services into the container below.
 *
 * It is Google's rendered widget rather than a TabDump-styled button on
 * purpose: Google's branding guidelines govern the mark, the wording and
 * the button's proportions, and a hand-built lookalike would both breach
 * them and — worse — teach users that a Google sign-in can look like
 * anything. Everything *around* it is TabDump's own design.
 *
 * The button only ever produces a credential. It never decides anything:
 * the credential goes straight to /api/auth/google, which is where identity
 * is actually established.
 */

/** GIS takes a pixel width (it caps at 400). Matches the sign-in panel's content column. */
const BUTTON_WIDTH = 320

type Phase =
  | { kind: "preparing" }
  | { kind: "ready" }
  | { kind: "submitting" }
  | { kind: "error"; message: string; retryable: boolean }

export function GoogleSignInButton({
  onCredential,
  onError,
}: {
  /** Handed the raw Google credential. Resolving with an error message re-arms the button with a fresh nonce; resolving with null means the sign-in completed. */
  onCredential: (credential: string) => Promise<string | null>
  onError?: (message: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: "preparing" })
  // Bumped to force a fresh nonce + re-initialization. A nonce is
  // single-use, so every attempt after the first needs a new one — without
  // this, a second try would always fail the nonce check.
  const [attempt, setAttempt] = useState(0)

  const clientId = publicGoogleClientId()

  const appearance = useOptionalAppearanceContext()
  const background = appearance?.resolvedColors?.background
  const googleTheme = background && isDarkColor(background) ? "filled_black" : "outline"

  // The latest handler, read from inside the GIS callback. GIS holds onto
  // whichever callback it was initialized with, so capturing the prop
  // directly would pin the first render's closure for the life of the
  // widget.
  const onCredentialRef = useRef(onCredential)
  // eslint-disable-next-line react-hooks/refs
  onCredentialRef.current = onCredential
  const onErrorRef = useRef(onError)
  // eslint-disable-next-line react-hooks/refs
  onErrorRef.current = onError

  const fail = useCallback((message: string, retryable: boolean) => {
    setPhase({ kind: "error", message, retryable })
    onErrorRef.current?.(message)
  }, [])

  useEffect(() => {
    // Nothing to arm without a client ID — the render below says so
    // instead, which keeps this effect free of a synchronous setState.
    if (!clientId) return

    // Re-bound after the guard so the async closure below sees it as a
    // definite string rather than re-widening to `string | undefined`.
    const googleClientId = clientId
    let cancelled = false
    const container = containerRef.current

    async function arm() {
      setPhase({ kind: "preparing" })

      const nonceResult = await requestLoginNonce()
      if (cancelled) return
      if (!nonceResult.ok) {
        fail(nonceResult.error.message, true)
        return
      }

      let gsi
      try {
        gsi = await loadGsi()
      } catch {
        if (cancelled) return
        // Almost always an ad/tracker blocker or an offline browser, so the
        // message names the likely cause rather than saying "unknown error".
        fail("Couldn't reach Google Sign-In. Check your connection or any content blockers, then try again.", true)
        return
      }
      if (cancelled || !container) return

      gsi.accounts.id.initialize({
        client_id: googleClientId,
        nonce: nonceResult.nonce,
        // Never sign someone in without them asking. Auto-select would
        // reinstate a previous account behind an explicit sign-out.
        auto_select: false,
        itp_support: true,
        callback: (response: GsiCredentialResponse) => {
          if (!response.credential) {
            fail("Google didn't return a sign-in. Try again.", true)
            return
          }
          setPhase({ kind: "submitting" })
          void onCredentialRef.current(response.credential).then((error) => {
            if (cancelled) return
            // A non-null message means the backend rejected it. The nonce
            // is spent either way, so a retry has to start over.
            if (error) fail(error, true)
          })
        },
      })

      container.replaceChildren()
      gsi.accounts.id.renderButton(container, {
        type: "standard",
        theme: googleTheme,
        size: "large",
        text: "continue_with",
        shape: "pill",
        logo_alignment: "left",
        width: BUTTON_WIDTH,
      })

      if (!cancelled) setPhase({ kind: "ready" })
    }

    void arm()
    return () => {
      cancelled = true
    }
  }, [attempt, clientId, googleTheme, fail])

  // Shouldn't be reachable — the panel around this only renders it when the
  // deployment reports itself configured — but a missing client ID must
  // never silently render a dead button.
  if (!clientId) {
    return (
      <p className="max-w-xs text-center text-body-sm text-destructive" role="alert">
        Sign-in isn&apos;t configured on this deployment.
      </p>
    )
  }

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {/* Kept mounted across every phase: GIS renders into this node, and
          unmounting it mid-flow would drop the widget it owns. Height is
          reserved so the panel doesn't jump as the button appears. */}
      <div
        ref={containerRef}
        aria-busy={phase.kind === "preparing"}
        className="flex min-h-11 w-full items-center justify-center"
        style={{ maxWidth: BUTTON_WIDTH }}
      />

      {phase.kind === "preparing" && (
        <p className="text-body-sm text-tertiary" role="status">
          Preparing sign-in…
        </p>
      )}

      {phase.kind === "submitting" && (
        <p className="text-body-sm text-tertiary" role="status">
          Signing you in…
        </p>
      )}

      {phase.kind === "error" && (
        <div className="flex flex-col items-center gap-2">
          <p className="max-w-xs text-center text-body-sm text-destructive" role="alert">
            {phase.message}
          </p>
          {phase.retryable && (
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
