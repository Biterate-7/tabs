"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Loader2, ShieldCheck, X } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SignInDialog } from "@/components/auth/sign-in-dialog"
import { NEVER_ALLOWED, PERMISSION_DESCRIPTION, PERMISSION_LABEL } from "@/lib/integrations/scopes"
import { formatFullDate } from "@/lib/time-format"
import type { PermissionLevel } from "@/lib/integrations/scopes"

/**
 * Hubble's OAuth consent page: where a person decides what ChatGPT, Claude,
 * Gemini, Grok or another MCP client may do with their Hubble.
 *
 * What it shows is chosen to make the decision an informed one:
 *
 *   - the client's name *as it claims*, and beside it the host the answer
 *     will actually be sent to — the one fact Hubble verified;
 *   - the permission, Read only by default whatever the client asked for;
 *   - the workspaces, none chosen until the person chooses (one, if that is
 *     all they have) — a connection never sees "everything";
 *   - what no connection can ever do, and what leaves Hubble.
 *
 * The page validates nothing itself. The server validates the request on
 * load and again on submit (src/app/api/oauth/authorize/route.ts), and only
 * the server decides where the browser goes next.
 */

type Workspace = { id: string; name: string; updatedAt: number }

type RequestSummary = {
  clientName: string
  clientProduct: string
  redirectHost: string
  requestedLevel: PermissionLevel
}

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid"; message: string; redirect?: string }
  | { kind: "unavailable"; message: string }
  | { kind: "signed-out"; request: RequestSummary }
  | { kind: "ready"; request: RequestSummary; account: { name: string; email: string }; workspaces: Workspace[] }

type Envelope<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } }

type AuthorizeAnswer =
  | { valid: false; error: string; redirect?: string }
  | { valid: true; signedIn: false; request: RequestSummary }
  | { valid: true; signedIn: true; request: RequestSummary; account: { name: string; email: string }; workspaces: Workspace[] }

function searchParams(): Record<string, string> {
  const out: Record<string, string> = {}
  new URLSearchParams(window.location.search).forEach((value, key) => {
    out[key] = value
  })
  return out
}

export function OAuthConsent() {
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [permission, setPermission] = useState<PermissionLevel>("read")
  const [chosen, setChosen] = useState<string[]>([])
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/oauth/authorize${window.location.search}`, { headers: { accept: "application/json" } })
      const body = (await response.json()) as Envelope<AuthorizeAnswer>
      if (!body.ok) {
        setState({ kind: "unavailable", message: body.error?.message ?? "Hubble cannot connect AI clients right now." })
        return
      }
      const answer = body.value
      if (!answer.valid) {
        setState({ kind: "invalid", message: answer.error, ...(answer.redirect ? { redirect: answer.redirect } : {}) })
        return
      }
      if (!answer.signedIn) {
        setState({ kind: "signed-out", request: answer.request })
        return
      }
      setState({ kind: "ready", request: answer.request, account: answer.account, workspaces: answer.workspaces })
      if (answer.workspaces.length === 1) setChosen([answer.workspaces[0].id])
    } catch {
      setState({ kind: "unavailable", message: "Hubble could not load this request. Check your connection and try again." })
    }
  }, [])

  useEffect(() => {
    // Synchronizing with the server on mount: what is being asked, and who
    // is signed in, are the server's to say.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  async function decide(decision: "approve" | "deny") {
    setSubmitting(decision)
    setError(null)
    try {
      const response = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: searchParams(), decision, permission, workspaceIds: chosen }),
      })
      const body = (await response.json()) as Envelope<{ redirect: string }>
      if (!body.ok) {
        setError(body.error?.message ?? "Hubble could not complete that.")
        setSubmitting(null)
        return
      }
      // Only ever a URL the server built from the client's verified redirect URI.
      window.location.assign(body.value.redirect)
    } catch {
      setError("Hubble could not complete that. Try again.")
      setSubmitting(null)
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-[560px] flex-col px-4 py-10 sm:px-6 sm:py-16">
        <span className="flex items-center gap-2 text-foreground">
          <BrandMark />
          <span className="text-body font-medium tracking-tight">Hubble</span>
        </span>

        {state.kind === "loading" && (
          <p className="mt-10 flex items-center gap-2 text-body text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Checking this request…
          </p>
        )}

        {(state.kind === "invalid" || state.kind === "unavailable") && (
          <section className="mt-10" aria-labelledby="consent-error">
            <h1 id="consent-error" className="text-h1 text-foreground">
              This connection can’t continue
            </h1>
            <p className="mt-2 text-body text-muted-foreground" role="alert">
              {state.message}
            </p>
            {state.kind === "invalid" && state.redirect && (
              <a className="mt-6 inline-block text-body text-link underline-offset-4 hover:underline" href={state.redirect}>
                Return to the app that sent you here
              </a>
            )}
          </section>
        )}

        {(state.kind === "signed-out" || state.kind === "ready") && (
          <section className="mt-10" aria-labelledby="consent-title">
            <h1 id="consent-title" className="text-h1 text-foreground">
              Connect {state.request.clientProduct === "Another MCP client" ? "an AI client" : state.request.clientProduct} to Hubble?
            </h1>
            <p className="mt-2 text-body text-muted-foreground">
              An app calling itself <strong className="font-medium text-foreground">“{state.request.clientName}”</strong> wants to use
              your Hubble. Approving sends access to <strong className="font-medium text-foreground">{state.request.redirectHost}</strong>.
              If you did not start this from that app, deny it.
            </p>

            {state.kind === "signed-out" && (
              <div className="mt-8 rounded-md border border-border p-4">
                <p className="text-body text-foreground">Sign in to choose what it can see.</p>
                <p className="mt-1 text-body-sm text-muted-foreground">
                  Only projects synced to your Hubble account can be shared.
                </p>
                <div className="mt-4 flex gap-2">
                  <Button type="button" onClick={() => setSignInOpen(true)}>
                    Sign in
                  </Button>
                  <Button type="button" variant="outline" disabled={submitting !== null} onClick={() => void decide("deny")}>
                    Deny
                  </Button>
                </div>
                <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
              </div>
            )}

            {state.kind === "ready" && (
              <form
                className="mt-8 flex flex-col gap-6"
                onSubmit={(event) => {
                  event.preventDefault()
                  void decide("approve")
                }}
              >
                <p className="text-body-sm text-muted-foreground">
                  Signed in as {state.account.name} ({state.account.email})
                </p>

                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-label text-muted-foreground">What it may do</legend>
                  {(["read", "write"] as const).map((level) => (
                    <label
                      key={level}
                      className="flex cursor-pointer gap-3 rounded-md border border-border p-3 has-checked:border-strong has-checked:bg-surface-hover"
                    >
                      <input
                        type="radio"
                        name="permission"
                        value={level}
                        checked={permission === level}
                        onChange={() => setPermission(level)}
                        className="mt-1 accent-(--primary)"
                      />
                      <span>
                        <span className="block text-body text-foreground">{PERMISSION_LABEL[level]}</span>
                        <span className="mt-0.5 block text-body-sm text-muted-foreground">{PERMISSION_DESCRIPTION[level]}</span>
                      </span>
                    </label>
                  ))}
                  {state.request.requestedLevel === "write" && permission === "read" && (
                    <p className="text-body-sm text-muted-foreground">
                      It asked to save changes too. You can allow that now, or later in Settings → AI Integrations.
                    </p>
                  )}
                </fieldset>

                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-label text-muted-foreground">Which projects it can see</legend>
                  {state.workspaces.length === 0 ? (
                    <p className="text-body-sm text-muted-foreground" role="alert">
                      None of your projects is synced to your account yet. Sync one in Hubble, then connect again from your AI app.
                    </p>
                  ) : (
                    <ul className="flex max-h-64 flex-col gap-1 overflow-auto rounded-md border border-border p-2">
                      {state.workspaces.map((workspace) => (
                        <li key={workspace.id}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-xs px-2 py-1.5 hover:bg-surface-hover">
                            <Checkbox
                              checked={chosen.includes(workspace.id)}
                              onCheckedChange={(checked) =>
                                setChosen((current) =>
                                  checked ? [...new Set([...current, workspace.id])] : current.filter((id) => id !== workspace.id)
                                )
                              }
                            />
                            <span className="min-w-0 flex-1 truncate text-body text-foreground">{workspace.name || "Untitled project"}</span>
                            {/* Two workspaces may share a name; the date tells them apart. */}
                            <span className="shrink-0 text-meta text-tertiary">updated {formatFullDate(workspace.updatedAt)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-body-sm text-muted-foreground">Projects kept only on a device are never visible to it.</p>
                </fieldset>

                <div className="rounded-md border border-border p-3">
                  <p className="flex items-center gap-2 text-body-sm font-medium text-foreground">
                    <ShieldCheck className="size-4" aria-hidden /> It can never
                  </p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {NEVER_ALLOWED.map((line) => (
                      <li key={line} className="flex items-start gap-2 text-body-sm text-muted-foreground">
                        <X className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {line}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-body-sm text-muted-foreground">
                    What it reads from Hubble is sent to {state.request.clientProduct === "Another MCP client" ? "that app" : state.request.clientProduct}{" "}
                    and handled under its privacy terms. Hubble keeps a record of what it does — not your conversations. You can
                    disconnect it any time in Settings → AI Integrations.
                  </p>
                </div>

                {error && (
                  <p className="text-body-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="lg" disabled={submitting !== null || chosen.length === 0}>
                    {submitting === "approve" ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                    {submitting === "approve" ? "Connecting…" : "Approve"}
                  </Button>
                  <Button type="button" size="lg" variant="outline" disabled={submitting !== null} onClick={() => void decide("deny")}>
                    Deny
                  </Button>
                </div>
                {chosen.length === 0 && state.workspaces.length > 0 && (
                  <p className="text-body-sm text-muted-foreground">Choose at least one project.</p>
                )}
              </form>
            )}
          </section>
        )}
      </div>
    </main>
  )
}
