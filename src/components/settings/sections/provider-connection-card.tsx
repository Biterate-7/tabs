"use client"

import { useCallback, useState } from "react"
import { ExternalLink, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AUTH_METHOD_LABEL,
  CONNECTION_STATUS_LABEL,
} from "@/lib/agents/credentials/types"
import { cn } from "@/lib/utils"
import type {
  AgentProviderId,
  CredentialValidation,
  ProviderConnectionView,
} from "@/lib/agents/credentials/types"
import type { ConnectInput } from "@/hooks/use-provider-connections"

/**
 * Settings → AI Connectors → Connection.
 *
 * The third block on a provider card, beside Observation and Control. Three
 * blocks because they are three genuinely independent facts:
 *
 *   - **Observation** — can Hubble see what this agent does?
 *   - **Control** — can Hubble drive it?
 *   - **Connection** — has *this user* authorized Hubble to use it, with
 *     their own credentials?
 *
 * A provider can be in any combination. Claude Code is observable on a machine
 * that has it, drivable where the runtime allows, and connected only once the
 * person has supplied their own key — and none of those three implies another.
 *
 * ## The naming, which is a correctness question
 *
 * The button says **Connect Anthropic API**, never "Connect Claude account".
 * Hubble holds an API credential the user issued to themselves. It does not
 * hold a delegated grant, cannot act as them, and cannot see their Claude.ai
 * subscription — and the second phrasing would claim all three. The
 * explanatory sentence comes from the credential adapter rather than from this
 * component, so the product cannot describe an authorization differently from
 * the thing that actually performs it.
 *
 * ## What this component never does
 *
 * Keep a secret. The field is uncontrolled below and its value is read once,
 * at submit, straight out of the form. It is not lifted into React state, not
 * echoed back after submission, and not re-displayed when the dialog reopens.
 * There is no "show key" toggle and no masked prefix: Hubble cannot revoke a
 * key from this screen, so displaying part of one buys recognition at the cost
 * of leaking it into every screenshot.
 */

/** What the credential adapter says about collecting this provider's secret. Server-derived. */
export type ConnectionInputShape = {
  label: string
  placeholder: string
  issueUrl: string
  explanation: string
}

export type ProviderConnectionCardProps = {
  provider: AgentProviderId
  providerName: string
  /** Absent when this user has not connected this provider. */
  connection: ProviderConnectionView | undefined
  /** Absent when Hubble has no credential adapter for this provider at all. */
  input: ConnectionInputShape | undefined
  /** The deployment cannot hold credentials — no encryption key configured. */
  unavailable: boolean
  /** Whether connections survive a restart here. */
  durable: boolean
  busy: boolean
  onConnect: (input: ConnectInput) => Promise<{ ok: boolean; validation?: CredentialValidation }>
  onRotate: (
    connectionId: string,
    secret: string
  ) => Promise<{ ok: boolean; validation?: CredentialValidation }>
  onDisconnect: (connectionId: string) => Promise<boolean>
}

export function ProviderConnectionCard({
  provider,
  providerName,
  connection,
  input,
  unavailable,
  durable,
  busy,
  onConnect,
  onRotate,
  onDisconnect,
}: ProviderConnectionCardProps) {
  // `connect` opens the form for a first credential; `rotate` opens the same
  // form for a replacement. One form, two intents, because the field, the
  // validation and the warning are identical and a second copy would drift.
  const [form, setForm] = useState<"closed" | "connect" | "rotate">("closed")
  const [failure, setFailure] = useState<CredentialValidation | null>(null)

  const close = useCallback(() => {
    setForm("closed")
    setFailure(null)
  }, [])

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const field = event.currentTarget.elements.namedItem("secret")
      const nameField = event.currentTarget.elements.namedItem("displayName")

      // Read once, out of the DOM, into a local that falls out of scope when
      // this function returns. It is never set into component state.
      const secret = field instanceof HTMLInputElement ? field.value : ""
      const displayName = nameField instanceof HTMLInputElement ? nameField.value : ""
      if (!secret.trim()) return

      const outcome =
        form === "rotate" && connection
          ? await onRotate(connection.id, secret)
          : await onConnect({ provider, secret, displayName: displayName.trim() || undefined })

      if (outcome.ok) {
        // Clearing the field is not security theatre here — the DOM node
        // outlives this handler by a frame or two before the form unmounts,
        // and there is no reason for the value to be in it during that time.
        if (field instanceof HTMLInputElement) field.value = ""
        close()
        return
      }

      setFailure(outcome.validation ?? null)
    },
    [form, connection, onConnect, onRotate, provider, close]
  )

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-body text-foreground">Connection</p>
        <span
          className={cn(
            "text-meta",
            connection?.status === "connected" ? "text-success" : "text-tertiary"
          )}
        >
          {statusWord(connection, input, unavailable)}
        </span>
      </div>

      {/* No credential adapter for this provider. Said plainly rather than
          shown as a Connect button that would fail — §20's "do not imply
          capabilities that do not exist". */}
      {!input ? (
        <p className="mt-1 text-meta text-muted-foreground">
          Hubble cannot hold credentials for {providerName} yet.
        </p>
      ) : unavailable ? (
        <p className="mt-1 text-meta text-muted-foreground">
          This deployment is not set up to store provider credentials.
        </p>
      ) : connection ? (
        <ConnectedDetail connection={connection} durable={durable} />
      ) : (
        <p className="mt-1 text-meta text-muted-foreground">{input.explanation}</p>
      )}

      {input && !unavailable && form === "closed" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {connection ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setForm("rotate")}
              >
                Rotate
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void onDisconnect(connection.id)}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" disabled={busy} onClick={() => setForm("connect")}>
              <KeyRound className="size-3.5" aria-hidden />
              Connect {AUTH_METHOD_LABEL.api_key}
            </Button>
          )}
        </div>
      )}

      {input && form !== "closed" && (
        <form className="mt-3 space-y-3" onSubmit={(event) => void submit(event)}>
          {form === "rotate" && (
            <p className="text-meta text-muted-foreground">
              {/* §12: the old credential stays active until the new one
                  validates. Said here because a user mid-rotation is exactly
                  the person who needs to know a failure is safe. */}
              Your current credential keeps working until the new one is verified.
            </p>
          )}

          <div>
            <label
              className="text-meta font-medium text-foreground"
              htmlFor={`secret-${provider}`}
            >
              {input.label}
            </label>
            <Input
              id={`secret-${provider}`}
              name="secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={input.placeholder}
              className="mt-1"
              // Uncontrolled. The value lives in this node and nowhere else
              // for as long as the form is mounted.
              defaultValue=""
              required
            />
          </div>

          {form === "connect" && (
            <div>
              <label
                className="text-meta font-medium text-foreground"
                htmlFor={`name-${provider}`}
              >
                Name <span className="text-tertiary">(optional)</span>
              </label>
              <Input
                id={`name-${provider}`}
                name="displayName"
                autoComplete="off"
                placeholder="Personal key"
                className="mt-1"
                defaultValue=""
              />
            </div>
          )}

          {failure && (
            <p role="alert" className="text-meta text-destructive">
              {/* From the fixed table in the credential domain. Never a
                  provider's own error text. */}
              {failure.message}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Verifying…" : form === "rotate" ? "Replace credential" : "Connect"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <a
              href={input.issueUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="ml-auto inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
            >
              Get a key
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </div>
        </form>
      )}
    </div>
  )
}

/** The status word, derived from what is actually registered rather than from a label table. */
function statusWord(
  connection: ProviderConnectionView | undefined,
  input: ConnectionInputShape | undefined,
  unavailable: boolean
): string {
  if (!input) return "Not supported"
  if (unavailable) return "Unavailable"
  if (!connection) return "Not connected"
  return CONNECTION_STATUS_LABEL[connection.status]
}

function ConnectedDetail({
  connection,
  durable,
}: {
  connection: ProviderConnectionView
  durable: boolean
}) {
  return (
    <div className="mt-1 space-y-0.5">
      <p className="text-meta text-muted-foreground">
        {AUTH_METHOD_LABEL[connection.authMethod]} · {connection.displayName}
      </p>
      <p className="text-meta text-tertiary">
        {connection.lastValidatedAt
          ? `Last validated ${new Date(connection.lastValidatedAt).toLocaleString()}`
          : "Not yet validated."}
      </p>
      {!durable && (
        <p className="text-meta text-tertiary">
          {/* Honest about the memory store rather than letting somebody
              discover it after a restart. */}
          Stored for this server process only — you will reconnect after a restart.
        </p>
      )}
    </div>
  )
}
