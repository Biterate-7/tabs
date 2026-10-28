"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowUpRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/components/auth/auth-provider"
import { desktopAccountApi } from "@/lib/platform"

type Phase = { kind: "idle" } | { kind: "waiting" } | { kind: "finishing" } | { kind: "failed"; message: string }

function messageOf(error: unknown, fallback: string): string {
  if (typeof error === "string" && error) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/**
 * Sign-in inside Hubble Desktop: the pairing flow (src-tauri/src/account.rs).
 *
 * Google won't sign in a desktop app's own pages, so the person approves the
 * app in their browser, where they already use Hubble. The browser hands back
 * a one-time code through `hubble://` — or shows it, to paste here when that
 * link can't reach the app. The code is worthless without the secret this app
 * kept, so pasting one can only ever sign in the app that asked.
 */
export function DesktopSignIn({ onDone }: { onDone: () => void }) {
  const account = desktopAccountApi()
  const { refresh } = useAuth()
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [code, setCode] = useState("")
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })

  useEffect(() => {
    if (!account) return
    let live = true
    let stop: (() => void) | undefined
    void account
      .onSignInResult((result) => {
        if (!live) return
        if (result.ok) done.current()
        else setPhase({ kind: "failed", message: result.error ?? "Sign-in didn't complete. Try again." })
      })
      .then((unlisten) => (live ? (stop = unlisten) : unlisten()))
    return () => {
      live = false
      stop?.()
    }
  }, [account])

  if (!account) return null

  async function begin() {
    try {
      await account!.beginSignIn()
      setPhase({ kind: "waiting" })
    } catch (error) {
      setPhase({ kind: "failed", message: messageOf(error, "Couldn't open your browser.") })
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault()
    if (!code.trim()) return
    setPhase({ kind: "finishing" })
    try {
      await account!.completeSignIn(code.trim())
      await refresh()
      onDone()
    } catch (error) {
      setPhase({ kind: "failed", message: messageOf(error, "That code didn't work. Start again.") })
    }
  }

  const waiting = phase.kind === "waiting" || phase.kind === "finishing"

  return (
    <div className="flex flex-col gap-4 py-2">
      <Button type="button" size="lg" onClick={() => void begin()} disabled={phase.kind === "finishing"}>
        {waiting ? "Open the browser again" : "Continue in your browser"} <ArrowUpRight />
      </Button>
      {waiting && (
        <p role="status" className="flex items-start gap-2 text-body-sm text-muted-foreground">
          <Loader2 aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          Approve Hubble Desktop in your browser. This window signs in by itself when you&rsquo;re done.
        </p>
      )}
      {phase.kind === "failed" && (
        <p role="alert" className="text-body-sm text-destructive">
          {phase.message}
        </p>
      )}
      {waiting && (
        <form onSubmit={submitCode} className="flex flex-col gap-2">
          <label htmlFor="desktop-sign-in-code" className="text-meta text-muted-foreground">
            If your browser shows a code instead, paste it here.
          </label>
          <div className="flex gap-2">
            <Input
              id="desktop-sign-in-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="hbc_…"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Button type="submit" variant="secondary" disabled={!code.trim() || phase.kind === "finishing"}>
              {phase.kind === "finishing" ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
