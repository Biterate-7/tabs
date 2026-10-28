"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { AuthProvider, useAuth } from "@/components/auth/auth-provider"
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button"
import { Button } from "@/components/ui/button"

/**
 * `/desktop/connect` — where a person approves Hubble Desktop for their
 * account (the pairing flow, src/lib/auth/device.ts).
 *
 * Opened by the desktop app in the default browser with a PKCE challenge, a
 * state value and a label. Nothing happens without the person pressing
 * Connect while signed in here; then the page asks for a single-use code
 * (bound to this account and that challenge) and hands it back to the app
 * through `hubble://auth/callback`, also showing it to paste in case the
 * link can't reach the app. The code alone signs in nothing: only the app
 * that made the challenge holds the verifier.
 */

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const STATE = /^[A-Za-z0-9_-]{16,128}$/

type Request = { challenge: string; state: string; label: string }
type Phase =
  | { kind: "ready" }
  | { kind: "connecting" }
  | { kind: "connected"; code: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }

/** The request in the address, or null when it isn't one Hubble Desktop made. */
export function readConnectRequest(search: string): Request | null {
  const params = new URLSearchParams(search)
  const challenge = params.get("challenge") ?? ""
  const state = params.get("state") ?? ""
  if (!CHALLENGE.test(challenge) || !STATE.test(state)) return null
  const label = (params.get("label") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || "Hubble Desktop"
  return { challenge, state, label }
}

export function callbackUrl(code: string, state: string): string {
  return `hubble://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
}

export function DesktopConnectPage() {
  return (
    <AuthProvider>
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
        <div className="w-full max-w-md rounded-lg border border-border bg-card px-6 py-6">
          <span className="flex items-center gap-2 text-foreground">
            <BrandMark />
            <span className="text-body font-medium tracking-tight">Hubble</span>
          </span>
          <ConnectBody />
        </div>
      </main>
    </AuthProvider>
  )
}

function ConnectBody() {
  const auth = useAuth()
  // Read after mount: the server has no address bar to read.
  const [request, setRequest] = useState<Request | null | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>({ kind: "ready" })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRequest(readConnectRequest(window.location.search))
  }, [])

  if (request === undefined || auth.status === "loading") return null

  if (request === null) {
    return (
      <Section title="This link isn't complete">
        Start again from Hubble Desktop: Settings → Account → Sign in.
      </Section>
    )
  }

  if (!auth.user) {
    if (!auth.configured) return <Section title="Accounts aren't available here">Hubble Desktop can&rsquo;t be connected from this site.</Section>
    return (
      <Section title="Sign in to connect Hubble Desktop">
        <span className="block">Sign in with the account you want {request.label} to use.</span>
        <span className="mt-4 flex justify-center">
          <GoogleSignInButton
            onCredential={async (credential) => {
              const result = await auth.completeGoogleSignIn(credential)
              return result.ok ? null : result.error.message
            }}
          />
        </span>
      </Section>
    )
  }

  async function connect() {
    setPhase({ kind: "connecting" })
    try {
      const response = await fetch("/api/auth/desktop/authorize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: request!.challenge, label: request!.label }),
      })
      const body = (await response.json().catch(() => ({}))) as { code?: unknown; error?: unknown }
      if (!response.ok || typeof body.code !== "string") {
        setPhase({ kind: "failed", message: typeof body.error === "string" ? body.error : "Couldn't connect Hubble Desktop. Try again." })
        return
      }
      setPhase({ kind: "connected", code: body.code })
      window.location.href = callbackUrl(body.code, request!.state)
    } catch {
      setPhase({ kind: "failed", message: "Couldn't reach Hubble. Check your connection and try again." })
    }
  }

  if (phase.kind === "connected") {
    return (
      <Section title="Return to Hubble Desktop">
        <span className="block">Hubble Desktop finishes signing in when it opens. You can close this tab.</span>
        <span className="mt-4 block text-meta text-tertiary">If it didn&rsquo;t open, paste this code into Hubble Desktop. It works once, for the next few minutes.</span>
        <span className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-meta text-foreground">{phase.code}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void navigator.clipboard.writeText(phase.code).then(
                () => setCopied(true),
                () => setCopied(false)
              )
            }
          >
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
          </Button>
        </span>
      </Section>
    )
  }

  if (phase.kind === "cancelled") {
    return <Section title="Nothing was connected">You can close this tab.</Section>
  }

  return (
    <Section title={`Connect ${request.label}?`}>
      <span className="block">
        It will be signed in as <span className="text-foreground">{auth.user.email}</span>, and can sync your projects and manage your AI connectors, as
        this browser can.
      </span>
      <span className="mt-2 block text-meta text-tertiary">Disconnect it any time in Settings → Account, here or in the app.</span>
      {phase.kind === "failed" && (
        <span role="alert" className="mt-3 block text-body-sm text-destructive">
          {phase.message}
        </span>
      )}
      <span className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setPhase({ kind: "cancelled" })} disabled={phase.kind === "connecting"}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void connect()} disabled={phase.kind === "connecting"}>
          {phase.kind === "connecting" ? "Connecting…" : "Connect"}
        </Button>
      </span>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <h1 className="text-h1 text-foreground">{title}</h1>
      <div className="mt-2 text-body text-muted-foreground">{children}</div>
    </div>
  )
}
